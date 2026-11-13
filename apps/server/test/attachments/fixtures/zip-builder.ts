/**
 * 테스트 전용 ZIP 조립기(정본 규칙: TRD §6-1-1 (1) 「ZIP 컨테이너 규칙」). 압축은 하지 않는다 — `method` 값과 무관하게
 * 데이터를 그대로 저장한다(판정기는 압축 해제를 하지 않으므로). CRC는 0이다. 옵션으로 규칙 위반 파일을 만든다.
 */
export interface ZipBuildEntry {
  name: string | Buffer;
  data?: Buffer;
  method?: number;
  flags?: number;
}

export interface ZipBuildOptions {
  /** EOCD 주석(주석 길이 필드에 반영). */
  comment?: Buffer;
  /** EOCD 뒤 잔여 바이트. */
  trailing?: Buffer;
  /** EOCD 앞에 ZIP64 로케이터(PK\x06\x07, 20바이트)를 끼운다. */
  zip64Locator?: boolean;
  /** EOCD 디스크 번호. */
  diskNumber?: number;
  /** EOCD 선언 엔트리 수(디스크·전체 둘 다). */
  declaredEntries?: number;
  /** EOCD 선언 cd_size에만 더한다(실제 바이트는 그대로). */
  cdSizeDelta?: number;
  /** 첫 로컬 헤더 앞 바이트(폴리글랏용). 오프셋은 이 길이만큼 밀린다. */
  prefix?: Buffer;
  /** 주석 안에 추가 EOCD 서명을 넣는다(주석 길이는 정확히 유지). */
  extraEocd?: boolean;
}

const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

const nameBytes = (name: string | Buffer): Buffer => (typeof name === 'string' ? Buffer.from(name, 'utf8') : name);

function localHeader(name: Buffer, data: Buffer, method: number, flags: number): Buffer {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(flags, 6);
  h.writeUInt16LE(method, 8);
  h.writeUInt32LE(data.length, 18);
  h.writeUInt32LE(data.length, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(0, 28);
  return Buffer.concat([h, name, data]);
}

function cdRecord(name: Buffer, data: Buffer, method: number, flags: number, offset: number): Buffer {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(flags, 8);
  h.writeUInt16LE(method, 10);
  h.writeUInt32LE(data.length, 20);
  h.writeUInt32LE(data.length, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt32LE(offset, 42);
  return Buffer.concat([h, name]);
}

function eocdRecord(count: number, cdSize: number, cdOffset: number, comment: Buffer, disk: number): Buffer {
  const h = Buffer.alloc(22);
  EOCD_SIG.copy(h, 0);
  h.writeUInt16LE(disk, 4);
  h.writeUInt16LE(0, 6);
  h.writeUInt16LE(count, 8);
  h.writeUInt16LE(count, 10);
  h.writeUInt32LE(cdSize, 12);
  h.writeUInt32LE(cdOffset, 16);
  h.writeUInt16LE(comment.length, 20);
  return Buffer.concat([h, comment]);
}

function zip64Locator(): Buffer {
  const h = Buffer.alloc(20);
  h.writeUInt32LE(0x07064b50, 0);
  h.writeUInt32LE(1, 16);
  return h;
}

export function buildZip(entries: readonly ZipBuildEntry[], options: ZipBuildOptions = {}): Buffer {
  const prefix = options.prefix ?? Buffer.alloc(0);
  const locals: Buffer[] = [];
  const records: Buffer[] = [];
  let offset = prefix.length;
  for (const e of entries) {
    const name = nameBytes(e.name);
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 8;
    const flags = e.flags ?? 0;
    const local = localHeader(name, data, method, flags);
    records.push(cdRecord(name, data, method, flags, offset));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(records);
  const baseComment = options.comment ?? Buffer.alloc(0);
  const comment = options.extraEocd ? Buffer.concat([baseComment, EOCD_SIG, Buffer.alloc(18)]) : baseComment;
  const eocd = eocdRecord(
    options.declaredEntries ?? entries.length,
    cd.length + (options.cdSizeDelta ?? 0),
    offset,
    comment,
    options.diskNumber ?? 0,
  );
  const locator = options.zip64Locator ? zip64Locator() : Buffer.alloc(0);
  return Buffer.concat([prefix, ...locals, cd, locator, eocd, options.trailing ?? Buffer.alloc(0)]);
}

const CONTENT_TYPES: ZipBuildEntry = { name: '[Content_Types].xml', data: Buffer.from('<Types/>') };

export const docxEntries = (extra: ZipBuildEntry[] = []): ZipBuildEntry[] => [
  CONTENT_TYPES,
  { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
  ...extra,
];

export const xlsxEntries = (extra: ZipBuildEntry[] = []): ZipBuildEntry[] => [
  CONTENT_TYPES,
  { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
  ...extra,
];

export const pptxEntries = (extra: ZipBuildEntry[] = []): ZipBuildEntry[] => [
  CONTENT_TYPES,
  { name: 'ppt/presentation.xml', data: Buffer.from('<p:presentation/>') },
  ...extra,
];

export const hwpxEntries = (extra: ZipBuildEntry[] = []): ZipBuildEntry[] => [
  { name: 'mimetype', data: Buffer.from('application/hwp+zip'), method: 0 },
  { name: 'Contents/content.hpf', data: Buffer.from('<opf:package/>') },
  ...extra,
];
