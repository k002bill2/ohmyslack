import { describe, expect, it } from 'vitest';
import type { SniffBudget } from '../../src/modules/attachments/doc-budget.js';
import { listZip, readStoredPrefix } from '../../src/modules/attachments/zip-list.js';
import { DOC_ZIP_MAX_CD_BYTES, DOC_ZIP_MAX_ENTRIES, DOC_ZIP_MAX_NAME_BYTES } from '../../src/shared.js';
import { buildZip, docxEntries, hwpxEntries } from './fixtures/zip-builder.js';
import type { ZipBuildEntry } from './fixtures/zip-builder.js';

/** ZIP 목록 판정기(정본: TRD §6-1-1 (1) 「ZIP 컨테이너 규칙」·(2) 자원 상한). */
const budget: SniffBudget = { now: () => 0, deadline: 1000 };
const unsupported = (reason: string) => ({ code: 'unsupported_media_type', reason });

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected throw');
}

const manyEntries = (count: number): ZipBuildEntry[] => Array.from({ length: count }, (_, i) => ({ name: `f/${i}.xml` }));

describe('listZip — 정상·비대상', () => {
  it('docx 목록을 이름·방식·오프셋과 함께 돌려준다', () => {
    const listing = listZip(buildZip(docxEntries()), budget);
    expect(listing?.entries.map((e) => e.name)).toEqual(['[Content_Types].xml', 'word/document.xml']);
    expect(listing?.entries[0]).toMatchObject({ method: 8, flags: 0, compressedSize: 8, uncompressedSize: 8, localHeaderOffset: 0 });
  });

  it('오프셋 0이 PK\\x03\\x04가 아니면 undefined(불일치)', () => {
    expect(listZip(Buffer.from('%PDF-1.7\n'), budget)).toBeUndefined();
    expect(listZip(Buffer.alloc(0), budget)).toBeUndefined();
    expect(listZip(buildZip(docxEntries(), { prefix: Buffer.from('%PDF-1.7\n') }), budget)).toBeUndefined();
  });
});

describe('listZip — EOCD·ZIP64·분할', () => {
  it('EOCD 뒤 잔여 바이트가 있으면 415', () => {
    expect(thrown(() => listZip(buildZip(docxEntries(), { trailing: Buffer.from('xx') }), budget))).toMatchObject(unsupported('zip_eocd'));
  });

  it('주석 길이가 맞는 EOCD는 통과, 주석 안 추가 EOCD 서명은 모호성으로 415', () => {
    expect(listZip(buildZip(docxEntries(), { comment: Buffer.from('hello') }), budget)?.entries).toHaveLength(2);
    expect(thrown(() => listZip(buildZip(docxEntries(), { extraEocd: true }), budget))).toMatchObject(unsupported('zip_eocd_multi'));
  });

  it('ZIP64 로케이터가 있으면 zip64', () => {
    expect(thrown(() => listZip(buildZip(docxEntries(), { zip64Locator: true }), budget))).toMatchObject(unsupported('zip64'));
  });

  it('EOCD 필드가 0xFFFF면 zip64', () => {
    expect(thrown(() => listZip(buildZip(docxEntries(), { diskNumber: 0xffff }), budget))).toMatchObject(unsupported('zip64'));
  });

  it('다중 디스크면 zip_split', () => {
    expect(thrown(() => listZip(buildZip(docxEntries(), { diskNumber: 1 }), budget))).toMatchObject(unsupported('zip_split'));
  });
});

describe('listZip — 자원 상한(중앙 디렉터리 읽기 전)', () => {
  it('선언 엔트리 수가 상한을 넘으면 CD를 읽지 않고 zip_entries', () => {
    const zip = buildZip(docxEntries(), { declaredEntries: DOC_ZIP_MAX_ENTRIES + 1 });
    const cdOffset = zip.readUInt32LE(zip.length - 6);
    zip.fill(0xaa, cdOffset, zip.length - 22); // CD를 쓰레기로 — 읽었다면 다른 사유가 나온다
    expect(thrown(() => listZip(zip, budget))).toMatchObject(unsupported('zip_entries'));
  });

  it('선언 cd_size가 상한을 넘으면 zip_cd_bytes', () => {
    expect(thrown(() => listZip(buildZip(docxEntries(), { cdSizeDelta: DOC_ZIP_MAX_CD_BYTES }), budget))).toMatchObject(
      unsupported('zip_cd_bytes'),
    );
  });

  it('cd_offset + cd_size가 EOCD 오프셋과 다르면 415', () => {
    expect(thrown(() => listZip(buildZip(docxEntries(), { cdSizeDelta: 1 }), budget))).toMatchObject(unsupported('zip_cd_offset'));
  });

  it('선언 엔트리 수가 실제 CD 레코드 수와 다르면 415', () => {
    expect(thrown(() => listZip(buildZip(docxEntries(), { declaredEntries: 1 }), budget))).toMatchObject(unsupported('zip_cd_count'));
    expect(thrown(() => listZip(buildZip(docxEntries(), { declaredEntries: 3 }), budget))).toMatchObject(unsupported('zip_cd_record'));
  });
});

describe('listZip — 엔트리 규칙', () => {
  it('이름 길이 상한 초과면 zip_name_bytes', () => {
    const long = 'a'.repeat(DOC_ZIP_MAX_NAME_BYTES + 1);
    expect(thrown(() => listZip(buildZip(docxEntries([{ name: long }])), budget))).toMatchObject(unsupported('zip_name_bytes'));
  });

  it('이름에 NUL이 있으면 zip_name_nul', () => {
    expect(thrown(() => listZip(buildZip(docxEntries([{ name: 'a\0b.xml' }])), budget))).toMatchObject(unsupported('zip_name_nul'));
  });

  it('이름이 유효 UTF-8이 아니면 415', () => {
    const bad = Buffer.from([0x61, 0xc3, 0x28]);
    expect(thrown(() => listZip(buildZip(docxEntries([{ name: bad }])), budget))).toMatchObject(unsupported('zip_name_utf8'));
  });

  it('이름이 중복이면 zip_name_dup', () => {
    expect(thrown(() => listZip(buildZip(docxEntries([{ name: 'word/document.xml' }])), budget))).toMatchObject(
      unsupported('zip_name_dup'),
    );
  });

  it('암호화 플래그(bit 0)면 encrypted_document', () => {
    expect(thrown(() => listZip(buildZip(docxEntries([{ name: 'x.xml', flags: 1 }])), budget))).toMatchObject({
      code: 'encrypted_document',
      reason: 'zip_encrypted',
    });
  });
});

describe('listZip — 벽시계 보조 상한', () => {
  it('256 엔트리마다 deadline을 확인하고 넘으면 sniff_deadline', () => {
    let calls = 0;
    const late: SniffBudget = { now: () => (calls++ === 0 ? 0 : 1001), deadline: 1000 };
    expect(thrown(() => listZip(buildZip(manyEntries(300)), late))).toMatchObject(unsupported('sniff_deadline'));
    expect(calls).toBe(2);
  });
});

describe('readStoredPrefix', () => {
  it('hwpx mimetype(무압축)을 compressedSize까지만 읽는다', () => {
    const zip = buildZip(hwpxEntries());
    const mimetype = listZip(zip, budget)?.entries[0];
    expect(mimetype?.name).toBe('mimetype');
    const prefix = mimetype && readStoredPrefix(zip, mimetype, 64);
    expect(prefix?.toString('latin1')).toBe('application/hwp+zip');
  });

  it('method 8·암호화·범위 밖이면 undefined', () => {
    const zip = buildZip(hwpxEntries());
    const entries = listZip(zip, budget)?.entries ?? [];
    const [mimetype, content] = entries;
    expect(content && readStoredPrefix(zip, content, 19)).toBeUndefined();
    expect(mimetype && readStoredPrefix(zip, { ...mimetype, flags: 1 }, 19)).toBeUndefined();
    expect(mimetype && readStoredPrefix(zip, { ...mimetype, localHeaderOffset: zip.length - 10 }, 19)).toBeUndefined();
    expect(mimetype && readStoredPrefix(zip, { ...mimetype, compressedSize: zip.length }, zip.length)).toBeUndefined();
  });
});
