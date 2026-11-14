import {
  ATTACHMENT_FILENAME_FALLBACK_STEM,
  ATTACHMENT_FILENAME_HEADER_MAX_BYTES,
  ATTACHMENT_FILENAME_MAX_BYTES,
  ATTACHMENT_FILENAME_MAX_CHARS,
} from '../../shared.js';

/**
 * 원 파일명 정규화(정본: TRD §6-1-1 (5) ①–⑧ 순서)와 다운로드 Content-Disposition(§6-1-1 (6), RFC 6266·5987).
 * 파일명은 projection에만 싣고 로그·계측·push에는 넣지 않는다(B6).
 */
export interface ParsedFilename {
  /** ①–⑤ 적용 후 확장자 앞 부분. */
  readonly stem: string;
  /** 원 파일명의 마지막 확장자(소문자, 점 제외). 없으면 ''. */
  readonly ext: string;
}

// ④ C0·DEL·C1·양방향 제어(U+061C, U+200E–200F, U+202A–202E, U+2066–2069).
// eslint-disable-next-line no-control-regex -- 제어문자 제거·검사가 목적(TRD §6-1-1 (5) ④)
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const EDGE_TRIM = /^[\s.]+|[\s.]+$/gu;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** ① 퍼센트 디코드 → 유효 UTF-8. 인코딩 값 상한 초과·잘못된 인코딩은 undefined(→ 400). */
export function decodeFilenameHeader(raw: string): string | undefined {
  if (Buffer.byteLength(raw, 'utf8') > ATTACHMENT_FILENAME_HEADER_MAX_BYTES) return undefined;
  if (/%(?![0-9a-fA-F]{2})/u.test(raw)) return undefined;
  const bytes = Buffer.from(raw.replace(/%([0-9a-fA-F]{2})/gu, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
  // 비 ASCII 원문(퍼센트 인코딩 안 된 값)은 latin1 왕복에서 깨지므로 거부한다.
// eslint-disable-next-line no-control-regex -- 제어문자 제거·검사가 목적(TRD §6-1-1 (5) ④)
  if (/[^\u0000-\u007f]/u.test(raw)) return undefined;
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** ②–⑤ + 확장자 분리. */
export function parseFilename(decoded: string): ParsedFilename {
  const nfc = decoded.normalize('NFC');
  const base = nfc.slice(Math.max(nfc.lastIndexOf('/'), nfc.lastIndexOf('\\')) + 1);
  const cleaned = base.replace(CONTROL_CHARS, '').replace(EDGE_TRIM, '');
  const dot = cleaned.lastIndexOf('.');
  if (dot <= 0) return { stem: cleaned, ext: '' };
  return { stem: cleaned.slice(0, dot), ext: cleaned.slice(dot + 1).toLowerCase() };
}

/** ⑥–⑧: 확장자를 판정 형식의 소문자 정규형으로 바꾸고 줄기를 code point 경계에서 잘라 ≤ 200자·≤ 255바이트, 빈 줄기는 `document`. */
export function finalizeFilename(stem: string, ext: string): string {
  const suffix = `.${ext}`;
  const maxChars = ATTACHMENT_FILENAME_MAX_CHARS - [...suffix].length;
  const maxBytes = ATTACHMENT_FILENAME_MAX_BYTES - Buffer.byteLength(suffix, 'utf8');
  let out = '';
  let bytes = 0;
  let chars = 0;
  for (const cp of stem) {
    const size = Buffer.byteLength(cp, 'utf8');
    if (chars + 1 > maxChars || bytes + size > maxBytes) break;
    out += cp;
    bytes += size;
    chars += 1;
  }
  const trimmed = out.replace(EDGE_TRIM, '');
  return `${trimmed === '' ? ATTACHMENT_FILENAME_FALLBACK_STEM : trimmed}${suffix}`;
}

// RFC 5987 attr-char(ALPHA / DIGIT / "!#$&+-.^_`|~"). 그 밖은 UTF-8 바이트별 %XX.
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/u;

function encodeRfc5987(value: string): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && ATTR_CHAR.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** ASCII 대체: 출력 가능 ASCII 밖 문자와 `"` `\` `%` `;`를 `_`로. */
export function asciiFallback(value: string): string {
  let out = '';
  for (const cp of value) out += /^[\u0020-\u007e]$/u.test(cp) && !/["\\%;]/u.test(cp) ? cp : '_';
  return out;
}

const nfdBytes = (value: string): number => Buffer.byteLength(value.normalize('NFD'), 'utf8');
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * 헤더용 이름 맞춤(§6-1-1 (6)): 저장 시 NFD로 바꿔 255바이트에서 자르는 클라이언트(iOS 「파일」)에서 음절이 자모로 깨지지 않게,
 * `NFD(이름)`이 상한을 넘으면 줄기를 자소(한글 음절·결합 문자·이모지 시퀀스) 경계에서 줄인다. 확장자는 보존. 저장 이름은 바꾸지 않는다.
 */
export function fitDownloadFilename(filename: string): string {
  if (nfdBytes(filename) <= ATTACHMENT_FILENAME_MAX_BYTES) return filename;
  const dot = filename.lastIndexOf('.');
  const suffix = dot > 0 ? filename.slice(dot) : '';
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  let out = '';
  for (const { segment } of GRAPHEMES.segment(stem)) {
    if (nfdBytes(`${out}${segment}${suffix}`) > ATTACHMENT_FILENAME_MAX_BYTES) break;
    out += segment;
  }
  const trimmed = out.replace(EDGE_TRIM, '');
  return `${trimmed === '' ? ATTACHMENT_FILENAME_FALLBACK_STEM : trimmed}${suffix}`;
}

/** 문서·텍스트 다운로드 헤더(§6-1-1 (6)). 원문 문자열을 그대로 넣지 않는다(CR·LF 주입 불가). */
export function attachmentDisposition(filename: string): string {
  const fitted = fitDownloadFilename(filename);
  return `attachment; filename="${asciiFallback(fitted)}"; filename*=UTF-8''${encodeRfc5987(fitted)}`;
}
