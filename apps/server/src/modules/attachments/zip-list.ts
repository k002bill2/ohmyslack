import { DOC_ZIP_EOCD_SCAN_BYTES, DOC_ZIP_MAX_CD_BYTES, DOC_ZIP_MAX_ENTRIES, DOC_ZIP_MAX_NAME_BYTES } from '../../shared.js';
import { checkDeadline, DocSniffError, reject } from './doc-budget.js';
import type { SniffBudget } from './doc-budget.js';

/**
 * ZIP 중앙 디렉터리 목록 판정기(정본: TRD §6-1-1 (1) 「ZIP 컨테이너 규칙」·(2) 자원 상한).
 * EOCD·중앙 디렉터리 **목록만** 읽는다. 압축 해제·XML 파싱은 0이고, 예외는 무압축 엔트리의 고정 길이 접두 읽기(readStoredPrefix)뿐이다.
 * 추가 할당은 중앙 디렉터리 크기(DOC_ZIP_MAX_CD_BYTES)에 비례한다.
 */
export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

export interface ZipListing {
  readonly entries: readonly ZipEntry[];
}

const SIG_LOCAL = 0x04034b50; // PK\x03\x04
const SIG_CD = 0x02014b50; // PK\x01\x02
const SIG_EOCD = 0x06054b50; // PK\x05\x06
const SIG_ZIP64_EOCD = 0x06064b50; // PK\x06\x06
const SIG_ZIP64_LOCATOR = 0x07064b50; // PK\x06\x07
const EOCD_LEN = 22;
const CD_FIXED_LEN = 46;
const LOCAL_FIXED_LEN = 30;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const DEADLINE_EVERY = 256;
const FLAG_ENCRYPTED = 0x0001;

interface Eocd {
  readonly offset: number;
  readonly disk: number;
  readonly cdDisk: number;
  readonly entriesOnDisk: number;
  readonly totalEntries: number;
  readonly cdSize: number;
  readonly cdOffset: number;
}

/** 스캔 창(파일 끝 DOC_ZIP_EOCD_SCAN_BYTES) 안의 서명 출현 위치를 모두 모은다. */
function scanSignatures(b: Buffer, sig: number): number[] {
  const found: number[] = [];
  const start = Math.max(0, b.length - DOC_ZIP_EOCD_SCAN_BYTES);
  for (let i = b.length - 4; i >= start; i -= 1) {
    if (b.readUInt32LE(i) === sig) found.push(i);
  }
  return found;
}

/** EOCD는 창 안에 정확히 하나, 그리고 22+주석 길이로 파일 끝에 정확히 닿아야 한다(잔여 바이트 0). */
function findEocd(b: Buffer): number {
  const hits = scanSignatures(b, SIG_EOCD);
  if (hits.length > 1) throw reject('zip_eocd_multi');
  const at = hits[0];
  if (at === undefined || at + EOCD_LEN > b.length) throw reject('zip_eocd');
  if (at + EOCD_LEN + b.readUInt16LE(at + 20) !== b.length) throw reject('zip_eocd');
  return at;
}

function parseEocd(b: Buffer, offset: number): Eocd {
  return {
    offset,
    disk: b.readUInt16LE(offset + 4),
    cdDisk: b.readUInt16LE(offset + 6),
    entriesOnDisk: b.readUInt16LE(offset + 8),
    totalEntries: b.readUInt16LE(offset + 10),
    cdSize: b.readUInt32LE(offset + 12),
    cdOffset: b.readUInt32LE(offset + 16),
  };
}

/** ZIP64 → 분할 → 엔트리 수 상한 → CD 크기 상한 → 오프셋 일치 순. 상한 검사는 중앙 디렉터리를 읽기 전이다. */
function validateEocd(b: Buffer, e: Eocd): void {
  if (scanSignatures(b, SIG_ZIP64_EOCD).length > 0 || scanSignatures(b, SIG_ZIP64_LOCATOR).length > 0) throw reject('zip64');
  const u16 = [e.disk, e.cdDisk, e.entriesOnDisk, e.totalEntries];
  if (u16.some((v) => v === U16_MAX) || e.cdSize === U32_MAX || e.cdOffset === U32_MAX) throw reject('zip64');
  if (e.disk !== 0 || e.cdDisk !== 0 || e.entriesOnDisk !== e.totalEntries) throw reject('zip_split');
  if (e.totalEntries > DOC_ZIP_MAX_ENTRIES) throw reject('zip_entries');
  if (e.cdSize > DOC_ZIP_MAX_CD_BYTES) throw reject('zip_cd_bytes');
  if (e.cdOffset + e.cdSize !== e.offset) throw reject('zip_cd_offset');
}

const nameDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeName(raw: Buffer): string {
  let name: string;
  try {
    name = nameDecoder.decode(raw);
  } catch {
    throw reject('zip_name_utf8');
  }
  if (name.includes('\0')) throw reject('zip_name_nul');
  return name;
}

/** 중앙 디렉터리 레코드 하나. 반환 next는 다음 레코드 시작 오프셋이다. */
function parseCdRecord(b: Buffer, at: number, e: Eocd): { entry: ZipEntry; next: number } {
  if (at + CD_FIXED_LEN > e.offset || b.readUInt32LE(at) !== SIG_CD) throw reject('zip_cd_record');
  const nameLen = b.readUInt16LE(at + 28);
  const next = at + CD_FIXED_LEN + nameLen + b.readUInt16LE(at + 30) + b.readUInt16LE(at + 32);
  if (next > e.offset) throw reject('zip_cd_record');
  if (nameLen > DOC_ZIP_MAX_NAME_BYTES) throw reject('zip_name_bytes');
  const entry: ZipEntry = {
    name: decodeName(b.subarray(at + CD_FIXED_LEN, at + CD_FIXED_LEN + nameLen)),
    flags: b.readUInt16LE(at + 8),
    method: b.readUInt16LE(at + 10),
    compressedSize: b.readUInt32LE(at + 20),
    uncompressedSize: b.readUInt32LE(at + 24),
    localHeaderOffset: b.readUInt32LE(at + 42),
  };
  if (entry.compressedSize === U32_MAX || entry.uncompressedSize === U32_MAX || entry.localHeaderOffset === U32_MAX) {
    throw reject('zip64');
  }
  if ((entry.flags & FLAG_ENCRYPTED) !== 0) throw new DocSniffError('encrypted_document', 'zip_encrypted');
  if (entry.localHeaderOffset >= e.cdOffset) throw reject('zip_local_offset');
  return { entry, next };
}

function walkCd(b: Buffer, e: Eocd, budget: SniffBudget): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let at = e.cdOffset;
  for (let i = 0; i < e.totalEntries; i += 1) {
    if (i % DEADLINE_EVERY === 0) checkDeadline(budget);
    const { entry, next } = parseCdRecord(b, at, e);
    if (names.has(entry.name)) throw reject('zip_name_dup');
    names.add(entry.name);
    entries.push(entry);
    at = next;
  }
  if (at !== e.offset) throw reject('zip_cd_count');
  return entries;
}

/**
 * undefined = ZIP 아님(오프셋 0이 PK\x03\x04가 아님) → 호출자는 "불일치"로 본다.
 * ZIP 서명인데 규칙을 어기면 DocSniffError를 던진다(→ 415).
 */
export function listZip(b: Buffer, budget: SniffBudget): ZipListing | undefined {
  if (b.length < 4 || b.readUInt32LE(0) !== SIG_LOCAL) return undefined;
  const eocd = parseEocd(b, findEocd(b));
  validateEocd(b, eocd);
  return { entries: walkCd(b, eocd, budget) };
}

/**
 * 무압축(method 0) 엔트리 데이터 접두의 고정 길이 읽기. 로컬 헤더(PK\x03\x04)를 확인하고 30+이름+extra를 건너뛴다.
 * method != 0·암호화·범위 밖이면 undefined. 최대 min(n, compressedSize) 바이트만 읽는다(잘라 내지 않고 범위 밖이면 undefined).
 */
export function readStoredPrefix(b: Buffer, entry: ZipEntry, n: number): Buffer | undefined {
  if (entry.method !== 0 || (entry.flags & FLAG_ENCRYPTED) !== 0) return undefined;
  const at = entry.localHeaderOffset;
  if (at + LOCAL_FIXED_LEN > b.length || b.readUInt32LE(at) !== SIG_LOCAL) return undefined;
  const start = at + LOCAL_FIXED_LEN + b.readUInt16LE(at + 26) + b.readUInt16LE(at + 28);
  const len = Math.max(0, Math.min(n, entry.compressedSize));
  if (start + len > b.length) return undefined;
  return Buffer.from(b.subarray(start, start + len));
}
