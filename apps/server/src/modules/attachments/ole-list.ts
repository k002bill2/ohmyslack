import { DOC_OLE_MAX_CHAIN_STEPS, DOC_OLE_MAX_DIR_ENTRIES, DOC_OLE_MAX_DIR_SECTORS } from '../../shared.js';
import { checkDeadline, DocSniffError, reject, type SniffBudget } from './doc-budget.js';

/**
 * OLE(MS-CFB 복합 파일) 디렉터리 목록 판정기(정본: TRD §6-1-1 (1) 「OLE 컨테이너 규칙」·(2) 자원 상한).
 * 헤더·FAT/DIFAT·디렉터리 엔트리 **목록만** 읽는다. 스트림 내용은 `readOleStreamPrefix`의 고정 길이 앞부분 읽기 외에는 보지 않는다.
 * 서명이 없으면 undefined(불일치), 서명이 맞는데 규칙을 어기면 DocSniffError(→ 415).
 */
export interface OleEntry {
  readonly index: number;
  readonly name: string;
  readonly type: 'root' | 'storage' | 'stream';
  /** 이 엔트리를 담은 저장소의 인덱스. 루트는 -1. */
  readonly parent: number;
  readonly size: number;
  readonly startSector: number;
}

export interface OleListing {
  readonly entries: readonly OleEntry[];
  readonly sectorSize: number;
  readonly fileSectors: number;
  readonly fat: readonly number[];
  readonly miniFat: readonly number[];
  readonly miniCutoff: number;
  /** 목록 단계에서 쓴 체인 단계 수(앞부분 읽기가 이어서 센다). */
  readonly steps: number;
}

const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const HEADER_BYTES = 512;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const NOSTREAM = 0xffffffff;
const HEADER_DIFAT_SLOTS = 109;
const DIR_ENTRY_BYTES = 128;
const MINI_SECTOR_BYTES = 64;
const MINI_CUTOFF = 4096;
const DEADLINE_EVERY = 256;
const ENCRYPTED_NAMES = new Set(['ENCRYPTIONINFO', 'ENCRYPTEDPACKAGE']);

interface Ctx {
  readonly b: Buffer;
  readonly budget: SniffBudget;
  readonly ss: number;
  readonly fileSectors: number;
  steps: number;
}

interface Header {
  readonly major: number;
  readonly ss: number;
  readonly numFat: number;
  readonly firstDir: number;
  readonly firstMiniFat: number;
  readonly numMiniFat: number;
  readonly firstDifat: number;
}

interface RawEntry {
  readonly name: string;
  readonly typeCode: number;
  readonly left: number;
  readonly right: number;
  readonly child: number;
  readonly startSector: number;
  readonly size: number;
}

function step(ctx: Ctx): void {
  ctx.steps += 1;
  if (ctx.steps > DOC_OLE_MAX_CHAIN_STEPS) throw reject('ole_chain_steps');
  if (ctx.steps % DEADLINE_EVERY === 0) checkDeadline(ctx.budget);
}

function sectorOffset(ctx: Ctx, sid: number): number {
  if (sid >= ctx.fileSectors) throw reject('ole_sector_range');
  return (sid + 1) * ctx.ss;
}

/**
 * `table` 체인을 `start`부터 따라간다. 번호는 `bound` 미만이어야 하고 재방문은 순환이다.
 * `max`개에 닿으면 `overflow`가 있으면 거부, 없으면 거기서 멈춘다(앞부분만 필요할 때).
 */
function walk(ctx: Ctx, table: readonly number[], start: number, bound: number, max: number, overflow?: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  let sid = start;
  while (sid !== ENDOFCHAIN) {
    if (out.length === max) {
      if (overflow !== undefined) throw reject(overflow);
      return out;
    }
    if (sid >= bound) throw reject('ole_sector_range');
    if (seen.has(sid)) throw reject('ole_cycle');
    seen.add(sid);
    out.push(sid);
    const next = table[sid];
    if (next === undefined) throw reject('ole_sector_range');
    step(ctx);
    sid = next;
  }
  return out;
}

function readHeader(b: Buffer): Header {
  if (b.length < HEADER_BYTES) throw reject('ole_truncated');
  if (b.readUInt16LE(0x1c) !== 0xfffe) throw reject('ole_byte_order');
  const major = b.readUInt16LE(0x1a);
  const shift = b.readUInt16LE(0x1e);
  const ss = major === 3 && shift === 9 ? 512 : major === 4 && shift === 12 ? 4096 : 0;
  if (ss === 0) throw reject('ole_version');
  if (b.length < ss) throw reject('ole_truncated');
  if (b.readUInt16LE(0x20) !== 6 || b.readUInt32LE(0x38) !== MINI_CUTOFF) throw reject('ole_mini_params');
  return {
    major,
    ss,
    numFat: b.readUInt32LE(0x2c),
    firstDir: b.readUInt32LE(0x30),
    firstMiniFat: b.readUInt32LE(0x3c),
    numMiniFat: b.readUInt32LE(0x40),
    firstDifat: b.readUInt32LE(0x44),
  };
}

/** 헤더 DIFAT 109칸 + DIFAT 체인(각 섹터 끝 칸 = 다음 DIFAT 섹터)에서 FAT 섹터 번호를 모은다. */
function fatSectorIds(ctx: Ctx, h: Header): number[] {
  // FAT 섹터 하나가 ss/4개 섹터를 담는다. 파일 섹터(끝의 부분 섹터 포함)를 다 덮는 데 필요한 수보다 많으면 거부.
  if (h.numFat > Math.ceil((ctx.fileSectors + 1) / (ctx.ss / 4))) throw reject('ole_fat_count');
  const ids: number[] = [];
  for (let i = 0; i < Math.min(HEADER_DIFAT_SLOTS, h.numFat); i += 1) ids.push(ctx.b.readUInt32LE(0x4c + i * 4));
  const perSector = ctx.ss / 4 - 1;
  const seen = new Set<number>();
  let sid = h.firstDifat;
  while (ids.length < h.numFat && sid !== ENDOFCHAIN && sid !== FREESECT) {
    const off = sectorOffset(ctx, sid);
    if (seen.has(sid)) throw reject('ole_cycle');
    seen.add(sid);
    step(ctx);
    for (let i = 0; i < perSector && ids.length < h.numFat; i += 1) ids.push(ctx.b.readUInt32LE(off + i * 4));
    sid = ctx.b.readUInt32LE(off + perSector * 4);
  }
  if (ids.length < h.numFat) throw reject('ole_fat_count');
  // 같은 섹터를 여러 번 참조하면 테이블만 부풀린다(할당 상한 우회) — 거부.
  if (new Set(ids).size !== ids.length) throw reject('ole_fat_dup');
  return ids;
}

/**
 * 섹터들을 번호 테이블로 복사한다. 항목은 `maxEntries`개까지만 만든다(그 뒤 번호는 체인 순회의 범위 검사로 어차피 쓸 수 없다).
 * 섹터마다 단계 예산을 센다(단계 256개마다 deadline 확인, TRD §6-1-1 (2)).
 */
function readSectorTable(ctx: Ctx, sectors: readonly number[], maxEntries: number): number[] {
  const out: number[] = [];
  for (const sid of sectors) {
    if (out.length >= maxEntries) break;
    step(ctx);
    const off = sectorOffset(ctx, sid);
    for (let i = 0; i < ctx.ss && out.length < maxEntries; i += 4) out.push(ctx.b.readUInt32LE(off + i));
  }
  return out;
}

function decodeName(b: Buffer, off: number): string {
  const len = b.readUInt16LE(off + 0x40);
  if (len < 2 || len > 64 || len % 2 !== 0) throw reject('ole_entry_name');
  if (b.readUInt16LE(off + len - 2) !== 0) throw reject('ole_entry_name');
  const name = b.toString('utf16le', off, off + len - 2);
  if (name.includes('\u0000')) throw reject('ole_entry_name');
  return name;
}

function readEntry(b: Buffer, off: number, major: number): RawEntry | undefined {
  const typeCode = b.readUInt8(off + 0x42);
  if (typeCode === 0) return undefined;
  if (typeCode !== 1 && typeCode !== 2 && typeCode !== 5) throw reject('ole_entry_type');
  if (major === 4 && b.readUInt32LE(off + 0x7c) !== 0) throw reject('ole_entry_size');
  return {
    name: decodeName(b, off),
    typeCode,
    left: b.readUInt32LE(off + 0x44),
    right: b.readUInt32LE(off + 0x48),
    child: b.readUInt32LE(off + 0x4c),
    startSector: b.readUInt32LE(off + 0x74),
    size: b.readUInt32LE(off + 0x78),
  };
}

/** 디렉터리 체인을 읽어 비어 있지 않은 엔트리만 인덱스→원시 엔트리로 모은다. 반환 slots = 전체 슬롯 수. */
function readDirectory(ctx: Ctx, h: Header, fat: readonly number[]): { raw: Map<number, RawEntry>; slots: number } {
  const sectors = walk(ctx, fat, h.firstDir, ctx.fileSectors, DOC_OLE_MAX_DIR_SECTORS, 'ole_dir_sectors');
  const perSector = ctx.ss / DIR_ENTRY_BYTES;
  const raw = new Map<number, RawEntry>();
  sectors.forEach((sid, si) => {
    const base = sectorOffset(ctx, sid);
    for (let i = 0; i < perSector; i += 1) {
      const index = si * perSector + i;
      const entry = readEntry(ctx.b, base + i * DIR_ENTRY_BYTES, h.major);
      if (entry === undefined) continue;
      if ((entry.typeCode === 5) !== (index === 0)) throw reject('ole_root');
      raw.set(index, entry);
      if (raw.size > DOC_OLE_MAX_DIR_ENTRIES) throw reject('ole_dir_entries');
    }
  });
  if (!raw.has(0)) throw reject('ole_root');
  return { raw, slots: sectors.length * perSector };
}

/** 각 저장소의 자식 레드-블랙 트리를 좌·우 형제와 child로 따라가 부모를 정한다. DID 재등장은 순환. */
function assignParents(raw: ReadonlyMap<number, RawEntry>, slots: number): Map<number, number> {
  const parents = new Map<number, number>([[0, -1]]);
  const storages = [0];
  while (storages.length > 0) {
    const owner = storages.pop() as number;
    const stack = [(raw.get(owner) as RawEntry).child];
    while (stack.length > 0) {
      const did = stack.pop() as number;
      if (did === NOSTREAM) continue;
      const entry = did < slots ? raw.get(did) : undefined;
      if (entry === undefined) throw reject('ole_dir_ref');
      if (parents.has(did)) throw reject('ole_cycle');
      parents.set(did, owner);
      stack.push(entry.left, entry.right);
      if (entry.typeCode === 1) storages.push(did);
    }
  }
  return parents;
}

const TYPE_NAMES: Readonly<Record<number, OleEntry['type']>> = { 1: 'storage', 2: 'stream', 5: 'root' };

function toEntries(raw: ReadonlyMap<number, RawEntry>, parents: ReadonlyMap<number, number>): OleEntry[] {
  return [...parents.keys()]
    .sort((a, c) => a - c)
    .map((index) => {
      const r = raw.get(index) as RawEntry;
      return Object.freeze({
        index,
        name: r.name,
        type: TYPE_NAMES[r.typeCode] ?? 'stream',
        parent: parents.get(index) as number,
        size: r.size,
        startSector: r.startSector,
      });
    });
}

function readMiniFat(ctx: Ctx, h: Header, fat: readonly number[]): number[] {
  if (h.numMiniFat === 0 || h.firstMiniFat === ENDOFCHAIN) return [];
  if (h.numMiniFat > ctx.fileSectors) throw reject('ole_minifat_count');
  // 미니 섹터는 일반 섹터 하나에 ss/64개 들어간다.
  return readSectorTable(ctx, walk(ctx, fat, h.firstMiniFat, ctx.fileSectors, h.numMiniFat, 'ole_minifat_count'), ctx.fileSectors * (ctx.ss / MINI_SECTOR_BYTES));
}

export function listOle(b: Buffer, budget: SniffBudget): OleListing | undefined {
  if (b.length < SIGNATURE.length || !b.subarray(0, SIGNATURE.length).equals(SIGNATURE)) return undefined;
  checkDeadline(budget);
  const h = readHeader(b);
  const ctx: Ctx = { b, budget, ss: h.ss, fileSectors: Math.floor((b.length - h.ss) / h.ss), steps: 0 };
  // FAT 항목 수 ≤ 파일 섹터 수: 파일 밖 번호의 다음 칸은 sectorOffset 범위 검사로 어차피 쓰이지 않는다.
  const fat = readSectorTable(ctx, fatSectorIds(ctx, h), ctx.fileSectors);
  const { raw, slots } = readDirectory(ctx, h, fat);
  const entries = toEntries(raw, assignParents(raw, slots));
  const miniFat = readMiniFat(ctx, h, fat);
  const listing: OleListing = Object.freeze({
    entries: Object.freeze(entries),
    sectorSize: h.ss,
    fileSectors: ctx.fileSectors,
    fat: Object.freeze(fat),
    miniFat: Object.freeze(miniFat),
    miniCutoff: MINI_CUTOFF,
    steps: ctx.steps,
  });
  if (rootChildren(listing).some((e) => ENCRYPTED_NAMES.has(e.name.toUpperCase()))) {
    throw new DocSniffError('encrypted_document', 'ole_encrypted');
  }
  return listing;
}

export function rootChildren(listing: OleListing): readonly OleEntry[] {
  return listing.entries.filter((e) => e.parent === 0);
}

function copySectors(ctx: Ctx, sectors: readonly number[], want: number): Buffer {
  const out = Buffer.alloc(want);
  sectors.forEach((sid, i) => {
    const off = sectorOffset(ctx, sid);
    ctx.b.copy(out, i * ctx.ss, off, off + Math.min(ctx.ss, want - i * ctx.ss));
  });
  return out;
}

function readMiniPrefix(ctx: Ctx, listing: OleListing, entry: OleEntry, want: number): Buffer {
  const root = listing.entries[0];
  if (root === undefined) throw reject('ole_root');
  const miniCount = Math.ceil(root.size / MINI_SECTOR_BYTES);
  const minis = walk(ctx, listing.miniFat, entry.startSector, miniCount, Math.ceil(want / MINI_SECTOR_BYTES));
  if (minis.length * MINI_SECTOR_BYTES < want) throw reject('ole_chain_short');
  const lastByte = Math.max(...minis) * MINI_SECTOR_BYTES + MINI_SECTOR_BYTES;
  const rootSectors = walk(ctx, listing.fat, root.startSector, ctx.fileSectors, Math.ceil(lastByte / ctx.ss));
  const out = Buffer.alloc(want);
  minis.forEach((m, i) => {
    const pos = m * MINI_SECTOR_BYTES;
    const sid = rootSectors[Math.floor(pos / ctx.ss)];
    if (sid === undefined) throw reject('ole_chain_short');
    const off = sectorOffset(ctx, sid) + (pos % ctx.ss);
    ctx.b.copy(out, i * MINI_SECTOR_BYTES, off, off + Math.min(MINI_SECTOR_BYTES, want - i * MINI_SECTOR_BYTES));
  });
  return out;
}

export function readOleStreamPrefix(b: Buffer, listing: OleListing, entry: OleEntry, n: number, budget: SniffBudget): Buffer {
  if (entry.type !== 'stream') throw reject('ole_not_stream');
  checkDeadline(budget);
  const want = Math.max(0, Math.min(n, entry.size));
  if (want === 0) return Buffer.alloc(0);
  const ctx: Ctx = { b, budget, ss: listing.sectorSize, fileSectors: listing.fileSectors, steps: listing.steps };
  if (entry.size < listing.miniCutoff) return readMiniPrefix(ctx, listing, entry, want);
  const sectors = walk(ctx, listing.fat, entry.startSector, ctx.fileSectors, Math.ceil(want / ctx.ss));
  if (sectors.length * ctx.ss < want) throw reject('ole_chain_short');
  return copySectors(ctx, sectors, want);
}
