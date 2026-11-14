/**
 * 테스트 전용 최소 OLE(MS-CFB) 빌더. 참고 출처: MS-CFB 공개 형식.
 * 배치: [헤더][FAT 섹터들][디렉터리][미니 FAT][미니 스트림][일반 스트림들]. 4096바이트 미만 스트림은 루트 엔트리의 미니 스트림에,
 * 그 이상은 일반 섹터에 둔다. 자식은 오른쪽 형제 사슬로 잇는다(색은 검정 — 판정기는 색을 보지 않는다).
 */
export interface OleNode {
  name: string;
  type: 'storage' | 'stream';
  data?: Buffer;
  children?: OleNode[];
}

export interface OleBuildOptions {
  major?: 3 | 4;
  byteOrder?: number;
  /** 디렉터리 체인의 마지막 섹터가 자기 자신을 가리키게 한다. */
  cyclicFat?: boolean;
  /** 헤더 DIFAT[0](첫 FAT 섹터 번호)을 파일 섹터 수 밖으로 둔다. */
  fatSectorOutOfRange?: boolean;
  /** 디렉터리 체인 뒤에 빈 엔트리 섹터 N개를 덧붙인다. */
  extraDirSectors?: number;
}

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;
const MINI_CUTOFF = 4096;
const MINI = 64;

interface FlatEntry {
  name: string;
  typeCode: 1 | 2 | 5;
  child: number;
  right: number;
  data: Buffer;
  start: number;
  size: number;
}

function flatten(rootChildren: readonly OleNode[]): FlatEntry[] {
  const out: FlatEntry[] = [{ name: 'Root Entry', typeCode: 5, child: NOSTREAM, right: NOSTREAM, data: Buffer.alloc(0), start: ENDOFCHAIN, size: 0 }];
  const addChildren = (owner: number, nodes: readonly OleNode[]): void => {
    let prev = -1;
    for (const node of nodes) {
      const index = out.length;
      out.push({ name: node.name, typeCode: node.type === 'storage' ? 1 : 2, child: NOSTREAM, right: NOSTREAM, data: node.data ?? Buffer.alloc(0), start: ENDOFCHAIN, size: 0 });
      const ownerOrPrev = out[prev === -1 ? owner : prev] as FlatEntry;
      if (prev === -1) ownerOrPrev.child = index;
      else ownerOrPrev.right = index;
      prev = index;
      if (node.type === 'storage') addChildren(index, node.children ?? []);
    }
  };
  addChildren(0, rootChildren);
  return out;
}

function writeEntry(buf: Buffer, off: number, e: FlatEntry): void {
  if (e.name.length > 31) throw new Error(`OLE name too long: ${e.name}`);
  buf.write(e.name, off, 'utf16le');
  buf.writeUInt16LE((e.name.length + 1) * 2, off + 0x40);
  buf.writeUInt8(e.typeCode, off + 0x42);
  buf.writeUInt8(1, off + 0x43);
  buf.writeUInt32LE(NOSTREAM, off + 0x44);
  buf.writeUInt32LE(e.right, off + 0x48);
  buf.writeUInt32LE(e.child, off + 0x4c);
  buf.writeUInt32LE(e.start, off + 0x74);
  buf.writeUInt32LE(e.size, off + 0x78);
}

function emptyEntry(buf: Buffer, off: number): void {
  buf.writeUInt32LE(NOSTREAM, off + 0x44);
  buf.writeUInt32LE(NOSTREAM, off + 0x48);
  buf.writeUInt32LE(NOSTREAM, off + 0x4c);
}

const pad = (data: Buffer, unit: number): Buffer => Buffer.concat([data, Buffer.alloc((unit - (data.length % unit)) % unit)]);
const sectorsOf = (bytes: number, ss: number): number => Math.ceil(bytes / ss);

interface Plan {
  ss: number;
  fatCount: number;
  dirStart: number;
  dirCount: number;
  miniFatStart: number;
  miniFatCount: number;
  miniStart: number;
  miniCount: number;
  bigStart: number;
  total: number;
}

function plan(ss: number, dirCount: number, miniFatCount: number, miniCount: number, bigCount: number): Plan {
  const body = dirCount + miniFatCount + miniCount + bigCount;
  let fatCount = 1;
  while (fatCount * (ss / 4) < body + fatCount) fatCount += 1;
  if (fatCount > 109) throw new Error('builder supports up to 109 FAT sectors');
  const dirStart = fatCount;
  const miniFatStart = dirStart + dirCount;
  const miniStart = miniFatStart + miniFatCount;
  const bigStart = miniStart + miniCount;
  return { ss, fatCount, dirStart, dirCount, miniFatStart, miniFatCount, miniStart, miniCount, bigStart, total: bigStart + bigCount };
}

function chainInto(fat: number[], start: number, count: number): void {
  for (let i = 0; i < count; i += 1) fat[start + i] = i === count - 1 ? ENDOFCHAIN : start + i + 1;
}

/** 스트림을 미니/일반으로 나눠 start·size를 채우고 미니 스트림·미니 FAT·일반 데이터를 만든다. */
function placeStreams(entries: FlatEntry[], ss: number): { mini: Buffer; miniFat: number[]; big: Buffer; bigOffsets: Map<number, number> } {
  const miniParts: Buffer[] = [];
  const miniFat: number[] = [];
  const bigParts: Buffer[] = [];
  const bigOffsets = new Map<number, number>();
  let miniSectors = 0;
  let bigSectors = 0;
  entries.forEach((e, index) => {
    if (e.typeCode !== 2) return;
    e.size = e.data.length;
    if (e.size === 0) return;
    if (e.size < MINI_CUTOFF) {
      const n = sectorsOf(e.size, MINI);
      e.start = miniSectors;
      chainInto(miniFat, miniSectors, n);
      miniParts.push(pad(e.data, MINI));
      miniSectors += n;
    } else {
      bigOffsets.set(index, bigSectors);
      bigParts.push(pad(e.data, ss));
      bigSectors += sectorsOf(e.size, ss);
    }
  });
  return { mini: Buffer.concat(miniParts), miniFat, big: Buffer.concat(bigParts), bigOffsets };
}

function buildFat(p: Plan, entries: FlatEntry[], bigOffsets: ReadonlyMap<number, number>, cyclic: boolean): number[] {
  const fat: number[] = new Array<number>(p.fatCount * (p.ss / 4)).fill(FREESECT);
  for (let i = 0; i < p.fatCount; i += 1) fat[i] = FATSECT;
  chainInto(fat, p.dirStart, p.dirCount);
  if (cyclic) fat[p.dirStart + p.dirCount - 1] = p.dirStart + p.dirCount - 1;
  if (p.miniFatCount > 0) chainInto(fat, p.miniFatStart, p.miniFatCount);
  if (p.miniCount > 0) chainInto(fat, p.miniStart, p.miniCount);
  bigOffsets.forEach((rel, index) => {
    const e = entries[index] as FlatEntry;
    e.start = p.bigStart + rel;
    chainInto(fat, e.start, sectorsOf(e.size, p.ss));
  });
  return fat;
}

function writeHeader(out: Buffer, p: Plan, major: 3 | 4, byteOrder: number, firstFat: number): void {
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(out, 0);
  out.writeUInt16LE(0x3e, 0x18);
  out.writeUInt16LE(major, 0x1a);
  out.writeUInt16LE(byteOrder, 0x1c);
  out.writeUInt16LE(major === 3 ? 9 : 12, 0x1e);
  out.writeUInt16LE(6, 0x20);
  out.writeUInt32LE(major === 3 ? 0 : p.dirCount, 0x28);
  out.writeUInt32LE(p.fatCount, 0x2c);
  out.writeUInt32LE(p.dirStart, 0x30);
  out.writeUInt32LE(MINI_CUTOFF, 0x38);
  out.writeUInt32LE(p.miniFatCount > 0 ? p.miniFatStart : ENDOFCHAIN, 0x3c);
  out.writeUInt32LE(p.miniFatCount, 0x40);
  out.writeUInt32LE(ENDOFCHAIN, 0x44);
  out.writeUInt32LE(0, 0x48);
  for (let i = 0; i < 109; i += 1) out.writeUInt32LE(i < p.fatCount ? (i === 0 ? firstFat : i) : FREESECT, 0x4c + i * 4);
}

export function buildOle(rootChildren: readonly OleNode[], options: OleBuildOptions = {}): Buffer {
  const major = options.major ?? 3;
  const ss = major === 3 ? 512 : 4096;
  const entries = flatten(rootChildren);
  const { mini, miniFat, big, bigOffsets } = placeStreams(entries, ss);
  const perDir = ss / 128;
  const p = plan(ss, sectorsOf(entries.length, perDir) + (options.extraDirSectors ?? 0), sectorsOf(miniFat.length * 4, ss), sectorsOf(mini.length, ss), sectorsOf(big.length, ss));
  const root = entries[0] as FlatEntry;
  root.start = p.miniCount > 0 ? p.miniStart : ENDOFCHAIN;
  root.size = mini.length;
  const fat = buildFat(p, entries, bigOffsets, options.cyclicFat ?? false);
  const out = Buffer.alloc(ss + p.total * ss);
  const firstFat = options.fatSectorOutOfRange ? p.total + 100 : 0;
  writeHeader(out, p, major, options.byteOrder ?? 0xfffe, firstFat);
  const at = (sid: number): number => (sid + 1) * ss;
  fat.forEach((v, i) => out.writeUInt32LE(v, at(0) + i * 4));
  for (let i = 0; i < p.dirCount * perDir; i += 1) {
    const e = entries[i];
    if (e === undefined) emptyEntry(out, at(p.dirStart) + i * 128);
    else writeEntry(out, at(p.dirStart) + i * 128, e);
  }
  const miniFatBytes = Buffer.alloc(p.miniFatCount * ss, 0xff);
  miniFat.forEach((v, i) => miniFatBytes.writeUInt32LE(v, i * 4));
  miniFatBytes.copy(out, at(p.miniFatStart));
  mini.copy(out, at(p.miniStart));
  big.copy(out, at(p.bigStart));
  return out;
}

const stream = (name: string, data: Buffer = Buffer.from(`${name} data`)): OleNode => ({ name, type: 'stream', data });
const storage = (name: string, children: OleNode[] = []): OleNode => ({ name, type: 'storage', children });

/** HWP 5.x FileHeader(256바이트): 앞 32바이트가 `HWP Document File` + NUL 패딩. */
export function hwpFileHeader(signature = 'HWP Document File'): Buffer {
  const header = Buffer.alloc(256);
  header.write(signature, 0, 'latin1');
  return header;
}

export function hwpTree(opts: { scripts?: boolean; header?: Buffer } = {}): OleNode[] {
  const nodes = [
    stream('FileHeader', opts.header ?? hwpFileHeader()),
    stream('DocInfo'),
    storage('BodyText', [stream('Section0')]),
  ];
  return opts.scripts ? [...nodes, storage('Scripts', [stream('DefaultJScript'), stream('JScriptVersion')])] : nodes;
}

export const docTree = (): OleNode[] => [stream('WordDocument'), stream('1Table')];
export const xlsTree = (): OleNode[] => [stream('Workbook')];
export const pptTree = (): OleNode[] => [stream('PowerPoint Document'), stream('Current User')];

export const vbaStorage = (): OleNode => storage('VBA', [stream('dir'), stream('_VBA_PROJECT')]);
/** Word 97–2003 매크로 저장소. */
export const macrosStorage = (): OleNode => storage('Macros', [vbaStorage(), stream('PROJECT')]);
/** Excel 97–2003 매크로 저장소. */
export const vbaProjectCurStorage = (): OleNode => storage('_VBA_PROJECT_CUR', [vbaStorage(), stream('PROJECT')]);
/** 암호 걸린 OOXML(EncryptionInfo·EncryptedPackage). */
export const encryptedTree = (): OleNode[] => [stream('EncryptionInfo'), stream('EncryptedPackage')];
export { storage as oleStorage, stream as oleStream };
