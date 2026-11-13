import type { AttachmentMime } from '../../shared.js';

/**
 * 내용 기반 형식 판정(정본: TRD §6-1 "서버가 매직 바이트로 판정"). 선언 Content-Type은 판정에 쓰지 않고 결과와 비교만 한다.
 * 외부 의존성 없이 헤더만 직접 파싱한다. 크기·길이는 읽을 수 있을 때만 채우고, 못 읽으면 null이다.
 */
export interface Sniffed {
  readonly mime: AttachmentMime;
  readonly durationMs: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const image = (mime: AttachmentMime, width: number | null, height: number | null): Sniffed => ({ mime, durationMs: null, width, height });

function sniffPng(b: Buffer): Sniffed | undefined {
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  // 첫 청크는 IHDR여야 한다(PNG 명세). 아니면 PNG로 보지 않는다.
  if (b.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return image('image/png', b.readUInt32BE(16), b.readUInt32BE(20));
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(b: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined; // EOI·SOS 전에 SOF가 없었다.
    const len = b.readUInt16BE(i + 2);
    if (JPEG_SOF.has(marker) && i + 9 <= b.length) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return undefined;
}

function sniffJpeg(b: Buffer): Sniffed | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return undefined;
  const size = jpegSize(b);
  return image('image/jpeg', size?.width ?? null, size?.height ?? null);
}

function webpSize(b: Buffer): { width: number; height: number } | undefined {
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return undefined;
}

function sniffWebp(b: Buffer): Sniffed | undefined {
  if (b.length < 16 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return undefined;
  const size = webpSize(b);
  return image('image/webp', size?.width ?? null, size?.height ?? null);
}

/** MPEG 오디오 프레임 헤더(Layer III 길이 계산용). 예약 값(버전 01·레이어 00·비트레이트 1111·샘플레이트 11)은 프레임이 아니다. */
interface MpegFrame {
  readonly version: 1 | 2 | 25;
  readonly layer: 1 | 2 | 3;
  readonly bitrateKbps: number;
  readonly sampleRate: number;
  readonly mono: boolean;
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Readonly<Record<1 | 2 | 25, readonly number[]>> = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

function mpegFrame(b: Buffer, at: number): MpegFrame | undefined {
  if (at + 4 > b.length || b[at] !== 0xff || ((b[at + 1] ?? 0) & 0xe0) !== 0xe0) return undefined;
  const b1 = b[at + 1] ?? 0;
  const b2 = b[at + 2] ?? 0;
  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const rateIndex = (b2 >> 2) & 0x03;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0x0f || rateIndex === 3) return undefined;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
  const layer = (4 - layerBits) as 1 | 2 | 3;
  const table = version === 1 ? BITRATES_V1_L3 : BITRATES_V2_L3;
  return {
    version,
    layer,
    bitrateKbps: layer === 3 ? (table[bitrateIndex] ?? 0) : 0,
    sampleRate: SAMPLE_RATES[version][rateIndex] ?? 0,
    mono: (((b[at + 3] ?? 0) >> 6) & 0x03) === 3,
  };
}

/** ID3v2 태그 길이(헤더 10 + syncsafe 크기 + 꼬리말 10). ID3가 아니면 0. */
function id3Length(b: Buffer): number {
  if (b.length < 10 || b.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size = (((b[6] ?? 0) & 0x7f) << 21) | (((b[7] ?? 0) & 0x7f) << 14) | (((b[8] ?? 0) & 0x7f) << 7) | ((b[9] ?? 0) & 0x7f);
  const footer = ((b[5] ?? 0) & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/**
 * mp3 길이(근사): Xing/Info 헤더의 프레임 수가 있으면 프레임 수 × 프레임당 샘플 / 샘플레이트(VBR 정확),
 * 없으면 첫 프레임 비트레이트로 CBR 추정. Layer III가 아니거나 값이 없으면 null.
 */
function mp3Duration(b: Buffer, start: number, frame: MpegFrame): number | null {
  if (frame.layer !== 3 || frame.sampleRate === 0) return null;
  const sideInfo = frame.version === 1 ? (frame.mono ? 17 : 32) : frame.mono ? 9 : 17;
  const tagAt = start + 4 + sideInfo;
  const tag = tagAt + 12 <= b.length ? b.toString('latin1', tagAt, tagAt + 4) : '';
  if ((tag === 'Xing' || tag === 'Info') && (b.readUInt32BE(tagAt + 4) & 0x1) !== 0) {
    const frames = b.readUInt32BE(tagAt + 8);
    const samples = frame.version === 1 ? 1152 : 576;
    return Math.round((frames * samples * 1000) / frame.sampleRate);
  }
  if (frame.bitrateKbps === 0) return null;
  return Math.round(((b.length - start) * 8) / frame.bitrateKbps);
}

function sniffMp3(b: Buffer): Sniffed | undefined {
  const start = id3Length(b);
  // ID3로 시작해도 태그 바로 뒤에 유효한 MPEG 프레임 sync가 있어야 mp3다(ID3 + 임의 내용 위장 거부).
  const frame = mpegFrame(b, start);
  if (frame === undefined) return undefined;
  return { mime: 'audio/mpeg', durationMs: mp3Duration(b, start, frame), width: null, height: null };
}

/** 미디어 판정기 4종(문서 판정의 단일 일치 규칙이 각각 돌린다, TRD §6-1-1 (1)). */
export const MEDIA_SNIFFERS: readonly ((b: Buffer) => Sniffed | undefined)[] = Object.freeze([sniffPng, sniffJpeg, sniffWebp, sniffMp3]);

/** 허용 4형식 중 하나로 판정되면 그 결과, 아니면 undefined(→ 415). */
export function sniff(bytes: Buffer): Sniffed | undefined {
  return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffWebp(bytes) ?? sniffMp3(bytes);
}

/** 선언 Content-Type 정규화(매개변수 제거·소문자). 비교 전용이며 판정에는 쓰지 않는다. */
export function declaredType(header: string | undefined): string {
  return (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}
