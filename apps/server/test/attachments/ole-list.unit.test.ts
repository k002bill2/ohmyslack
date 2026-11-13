import { describe, expect, it } from 'vitest';
import { DocSniffError, type SniffBudget } from '../../src/modules/attachments/doc-budget.js';
import { listOle, readOleStreamPrefix, rootChildren, type OleListing } from '../../src/modules/attachments/ole-list.js';
import { DOC_OLE_MAX_DIR_SECTORS } from '../../src/shared.js';
import { buildOle, encryptedTree, hwpTree, oleStream, xlsTree, type OleNode } from './fixtures/ole-builder.js';

/** OLE 목록 판정기(정본: TRD §6-1-1 (1) OLE 컨테이너 규칙·(2) 자원 상한). */
const budget: SniffBudget = { now: () => 0, deadline: 1 };

const list = (b: Buffer): OleListing => {
  const listing = listOle(b, budget);
  if (listing === undefined) throw new Error('expected OLE listing');
  return listing;
};

const errorOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected throw');
};

const expectReject = (fn: () => unknown, code: string, reason: string): void => {
  const err = errorOf(fn);
  expect(err).toBeInstanceOf(DocSniffError);
  expect(err).toMatchObject({ code, reason });
};

const byName = (listing: OleListing, name: string) => {
  const entry = listing.entries.find((e) => e.name === name);
  if (entry === undefined) throw new Error(`missing ${name}`);
  return entry;
};

describe('listOle', () => {
  it('v3: 루트 자식 이름과 중첩 저장소의 부모 인덱스', () => {
    const listing = list(buildOle(hwpTree({ scripts: true })));
    expect(listing.sectorSize).toBe(512);
    expect(rootChildren(listing).map((e) => e.name)).toEqual(['FileHeader', 'DocInfo', 'BodyText', 'Scripts']);
    const root = byName(listing, 'Root Entry');
    expect(root).toMatchObject({ index: 0, type: 'root', parent: -1 });
    const body = byName(listing, 'BodyText');
    expect(body.type).toBe('storage');
    expect(byName(listing, 'Section0')).toMatchObject({ type: 'stream', parent: body.index });
    expect(byName(listing, 'DefaultJScript').parent).toBe(byName(listing, 'Scripts').index);
  });

  it('v4: 4096바이트 섹터', () => {
    const listing = list(buildOle(xlsTree(), { major: 4 }));
    expect(listing.sectorSize).toBe(4096);
    expect(rootChildren(listing).map((e) => e.name)).toEqual(['Workbook']);
  });

  it('서명 없음 → undefined(불일치)', () => {
    const b = buildOle(xlsTree());
    b[0] = 0x00;
    expect(listOle(b, budget)).toBeUndefined();
    expect(listOle(Buffer.from('PK\x03\x04'), budget)).toBeUndefined();
  });

  it('바이트 순서·버전·잘린 헤더 → 415', () => {
    expectReject(() => listOle(buildOle(xlsTree(), { byteOrder: 0xfeff }), budget), 'unsupported_media_type', 'ole_byte_order');
    const v5 = buildOle(xlsTree());
    v5.writeUInt16LE(5, 0x1a);
    expectReject(() => listOle(v5, budget), 'unsupported_media_type', 'ole_version');
    const mixed = buildOle(xlsTree());
    mixed.writeUInt16LE(12, 0x1e);
    expectReject(() => listOle(mixed, budget), 'unsupported_media_type', 'ole_version');
    expectReject(() => listOle(buildOle(xlsTree()).subarray(0, 100), budget), 'unsupported_media_type', 'ole_truncated');
  });

  it('디렉터리 체인 순환 → ole_cycle', () => {
    expectReject(() => listOle(buildOle(xlsTree(), { cyclicFat: true }), budget), 'unsupported_media_type', 'ole_cycle');
  });

  it('FAT 섹터 번호가 파일 밖 → ole_sector_range', () => {
    expectReject(() => listOle(buildOle(xlsTree(), { fatSectorOutOfRange: true }), budget), 'unsupported_media_type', 'ole_sector_range');
  });

  it('디렉터리 섹터 상한 초과 → ole_dir_sectors', () => {
    expect(list(buildOle(xlsTree(), { extraDirSectors: DOC_OLE_MAX_DIR_SECTORS - 1 })).entries).toHaveLength(2);
    expectReject(() => listOle(buildOle(xlsTree(), { extraDirSectors: DOC_OLE_MAX_DIR_SECTORS }), budget), 'unsupported_media_type', 'ole_dir_sectors');
  });

  it('형제 사슬이 자기 자신을 가리킴 → ole_cycle', () => {
    const b = buildOle(xlsTree());
    const workbookOff = 512 * 2 + 128; // FAT 1섹터 뒤 디렉터리 섹터의 엔트리 1
    b.writeUInt32LE(1, workbookOff + 0x48);
    expectReject(() => listOle(b, budget), 'unsupported_media_type', 'ole_cycle');
  });

  it('루트에 EncryptionInfo → encrypted_document', () => {
    expectReject(() => listOle(buildOle(encryptedTree()), budget), 'encrypted_document', 'ole_encrypted');
  });

  it('벽시계 상한 초과 → sniff_deadline', () => {
    const late: SniffBudget = { now: () => 10, deadline: 1 };
    expectReject(() => listOle(buildOle(xlsTree()), late), 'unsupported_media_type', 'sniff_deadline');
  });
});

describe('readOleStreamPrefix', () => {
  it('미니 스트림 경유: FileHeader 앞 32바이트가 HWP Document File', () => {
    const b = buildOle(hwpTree());
    const listing = list(b);
    const header = byName(listing, 'FileHeader');
    expect(header.size).toBeLessThan(4096);
    const prefix = readOleStreamPrefix(b, listing, header, 32, budget);
    expect(prefix).toHaveLength(32);
    expect(prefix.subarray(0, 17).toString('latin1')).toBe('HWP Document File');
    expect(prefix.subarray(17).every((x) => x === 0)).toBe(true);
  });

  it('일반 FAT 체인 경유: 4096바이트 이상 스트림', () => {
    const data = Buffer.alloc(5000, 0x41);
    data.write('BIGSTREAM', 0, 'latin1');
    const tree: OleNode[] = [oleStream('Workbook', data), ...hwpTree()];
    const b = buildOle(tree, { major: 4 });
    const listing = list(b);
    const prefix = readOleStreamPrefix(b, listing, byName(listing, 'Workbook'), 4500, budget);
    expect(prefix).toEqual(data.subarray(0, 4500));
    expect(readOleStreamPrefix(b, listing, byName(listing, 'FileHeader'), 17, budget).toString('latin1')).toBe('HWP Document File');
  });

  it('스트림 체인이 파일 밖 섹터 → ole_sector_range', () => {
    const b = buildOle([oleStream('Workbook', Buffer.alloc(5000, 1))]);
    const listing = list(b);
    const wb = { ...byName(listing, 'Workbook'), startSector: 9999 };
    expectReject(() => readOleStreamPrefix(b, listing, wb, 32, budget), 'unsupported_media_type', 'ole_sector_range');
  });
});
