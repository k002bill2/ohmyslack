import { describe, expect, it } from 'vitest';
import { DocSniffError, type SniffBudget } from '../../src/modules/attachments/doc-budget.js';
import { binaryMatches, checkExtension, classify, type DocMatch } from '../../src/modules/attachments/doc-sniff.js';
import { ATTACHMENT_DOC_MIMES, ATTACHMENT_FILE_MIMES, ATTACHMENT_MIMES, ATTACHMENT_TEXT_MIMES } from '../../src/shared.js';
import { buildOle, docTree, encryptedTree, hwpFileHeader, hwpTree, oleStorage, oleStream, pptTree, xlsTree } from './fixtures/ole-builder.js';
import { buildZip, docxEntries, hwpxEntries, pptxEntries, xlsxEntries } from './fixtures/zip-builder.js';

/**
 * 문서·텍스트 판정 진입점(정본: TRD §6-1-1 (1) 허용 형식 9종·단일 일치 규칙·텍스트 계열, (4) 확장자-형식 일치, THREAT_MODEL TM-ATT-*).
 * 컨테이너 세부 규칙은 zip-list·ole-list 단위 테스트가 맡고, 여기서는 `classify`·`binaryMatches`·`checkExtension`을 거친 결과를 본다.
 */
const [PDF, DOCX, DOCM, XLSX, XLSM, PPTX, PPTM, HWPX, HWP, DOC, XLS, PPT] = ATTACHMENT_DOC_MIMES;
const [TXT, MD, CSV] = ATTACHMENT_TEXT_MIMES;
const [, PNG] = ATTACHMENT_MIMES;

const budget: SniffBudget = { now: () => 0, deadline: 1000 };
type FileMatch = Extract<DocMatch, { kind: 'file' }>;

const asFile = (m: DocMatch): FileMatch => {
  if (m.kind !== 'file') throw new Error('expected file match');
  return m;
};
const classifyFile = (b: Buffer, ext: string): FileMatch => asFile(classify(b, ext, budget));

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

const pdfBytes = (): Buffer => Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1');
/** IHDR까지의 최소 PNG 머리(미디어 판정기 일치용). */
const pngBytes = (): Buffer => {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(2, 16);
  b.writeUInt32BE(3, 20);
  return b;
};

interface NormalCase {
  readonly label: string;
  readonly bytes: () => Buffer;
  readonly ext: string;
  readonly mime: string | undefined;
  readonly extensions: readonly string[];
  readonly hasMacros: boolean;
}

const NORMAL: readonly NormalCase[] = [
  { label: 'PDF', bytes: pdfBytes, ext: 'pdf', mime: PDF, extensions: ['pdf'], hasMacros: false },
  { label: 'Word OOXML', bytes: () => buildZip(docxEntries()), ext: 'docx', mime: DOCX, extensions: ['docx', 'docm'], hasMacros: false },
  { label: 'Excel OOXML', bytes: () => buildZip(xlsxEntries()), ext: 'xlsx', mime: XLSX, extensions: ['xlsx', 'xlsm'], hasMacros: false },
  { label: 'PowerPoint OOXML', bytes: () => buildZip(pptxEntries()), ext: 'pptx', mime: PPTX, extensions: ['pptx', 'pptm'], hasMacros: false },
  { label: 'HWPX', bytes: () => buildZip(hwpxEntries()), ext: 'hwpx', mime: HWPX, extensions: ['hwpx'], hasMacros: false },
  { label: 'HWP 5.x', bytes: () => buildOle(hwpTree()), ext: 'hwp', mime: HWP, extensions: ['hwp'], hasMacros: false },
  { label: 'Word 97–2003', bytes: () => buildOle(docTree()), ext: 'doc', mime: DOC, extensions: ['doc'], hasMacros: false },
  { label: 'Excel 97–2003(보수 표시)', bytes: () => buildOle(xlsTree()), ext: 'xls', mime: XLS, extensions: ['xls'], hasMacros: true },
  { label: 'PowerPoint 97–2003(보수 표시)', bytes: () => buildOle(pptTree()), ext: 'ppt', mime: PPT, extensions: ['ppt'], hasMacros: true },
  { label: '텍스트 .txt', bytes: () => Buffer.from('hello\n안녕\n'), ext: 'txt', mime: TXT, extensions: ['txt'], hasMacros: false },
  { label: '텍스트 .md', bytes: () => Buffer.from('# 제목\n'), ext: 'md', mime: MD, extensions: ['md'], hasMacros: false },
  { label: '텍스트 .csv', bytes: () => Buffer.from('a,b\n1,2\n'), ext: 'csv', mime: CSV, extensions: ['csv'], hasMacros: false },
];

describe('classify — 형식별 정상 판정', () => {
  it.each(NORMAL)('$label', ({ bytes, ext, mime, extensions, hasMacros }) => {
    const match = classifyFile(bytes(), ext);
    expect(match).toMatchObject({ kind: 'file', mime, hasMacros, macroOoxml: false });
    expect(match.extensions).toEqual(extensions);
    expect(checkExtension(match, ext)).toEqual({ ok: true, ext });
  });

  it('v4(4096B 섹터) OLE도 같은 판정', () => {
    expect(classifyFile(buildOle(hwpTree(), { major: 4 }), 'hwp').mime).toBe(HWP);
    expect(classifyFile(buildOle(docTree(), { major: 4 }), 'doc').mime).toBe(DOC);
  });

  it('정상·매크로 판정 결과가 shared 파일 MIME 집합 전체를 덮는다', () => {
    const macroDocs = [
      buildZip(docxEntries([{ name: 'word/vbaProject.bin' }])),
      buildZip(xlsxEntries([{ name: 'xl/vbaProject.bin' }])),
      buildZip(pptxEntries([{ name: 'ppt/vbaProject.bin' }])),
    ].map((b) => classifyFile(b, '').mime);
    const seen = new Set([...NORMAL.map((c) => classifyFile(c.bytes(), c.ext).mime), ...macroDocs]);
    expect([...seen].sort()).toEqual([...ATTACHMENT_FILE_MIMES].sort());
    expect(macroDocs).toEqual([DOCM, XLSM, PPTM]);
  });

  it('미디어(PNG)는 단일 일치로 media를 돌려준다', () => {
    const match = classify(pngBytes(), 'png', budget);
    expect(match).toMatchObject({ kind: 'media', media: { mime: PNG, width: 2, height: 3 } });
  });

  it('텍스트: 선두 BOM 허용, 확장자로 MIME을 정한다(내용으로 구분하지 않음)', () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b\n')]);
    expect(classifyFile(bom, 'csv').mime).toBe(CSV);
    expect(classifyFile(Buffer.from('a,b\n'), 'md').mime).toBe(MD);
  });
});

describe('classify — 위장(이름 바꾸기·서명 변조)', () => {
  it('비슷한 매직(%PDX-)은 PDF가 아니고, 텍스트 확장자도 아니라 415', () => {
    expectReject(() => classify(Buffer.from('%PDX-1.7\n'), 'pdf', budget), 'unsupported_media_type', 'text_extension');
  });

  it('[Content_Types].xml 없는 ZIP·본문 파트 없는 OOXML은 어느 판정기와도 불일치 → no_match', () => {
    expectReject(() => classify(buildZip([{ name: 'word/document.xml' }]), 'docx', budget), 'unsupported_media_type', 'no_match');
    expectReject(() => classify(buildZip([{ name: '[Content_Types].xml' }, { name: 'word/other.xml' }]), 'docx', budget), 'unsupported_media_type', 'no_match');
  });

  it('HWPX 위장: mimetype이 압축 저장·첫 엔트리 아님·내용 다름·content.hpf 없음이면 no_match', () => {
    const [mimetype, hpf] = hwpxEntries();
    if (mimetype === undefined || hpf === undefined) throw new Error('fixture');
    const variants = [
      buildZip([{ ...mimetype, method: 8 }, hpf]),
      buildZip([hpf, mimetype]),
      buildZip([{ ...mimetype, data: Buffer.from('application/hwp+zix') }, hpf]),
      buildZip([mimetype]),
    ];
    for (const v of variants) expectReject(() => classify(v, 'hwpx', budget), 'unsupported_media_type', 'no_match');
  });

  it('HWP 위장: FileHeader 서명이 다르거나 필수 저장소가 없으면 no_match', () => {
    expectReject(() => classify(buildOle(hwpTree({ header: hwpFileHeader('HWP Document Filf') })), 'hwp', budget), 'unsupported_media_type', 'no_match');
    const noBody = hwpTree().filter((n) => n.name !== 'BodyText');
    expectReject(() => classify(buildOle(noBody), 'hwp', budget), 'unsupported_media_type', 'no_match');
    const bodyAsStream = [...noBody, oleStream('BodyText')];
    expectReject(() => classify(buildOle(bodyAsStream), 'hwp', budget), 'unsupported_media_type', 'no_match');
  });

  it('형식 스트림이 루트가 아닌 하위 저장소에 있으면 불일치', () => {
    expectReject(() => classify(buildOle([oleStorage('Nested', docTree())]), 'doc', budget), 'unsupported_media_type', 'no_match');
  });

  it('바이너리 쓰레기·NUL 포함·잘린 UTF-8은 텍스트가 아니라 no_match', () => {
    expectReject(() => classify(Buffer.from([0x00, 0x01, 0x02]), 'txt', budget), 'unsupported_media_type', 'no_match');
    expectReject(() => classify(Buffer.from('abc\0def'), 'txt', budget), 'unsupported_media_type', 'no_match');
    expectReject(() => classify(Buffer.from([0x61, 0xe3, 0x81]), 'txt', budget), 'unsupported_media_type', 'no_match');
    expectReject(() => classify(Buffer.from([0xc0, 0xaf]), 'txt', budget), 'unsupported_media_type', 'no_match');
    expectReject(() => classify(Buffer.from([0xed, 0xa0, 0x80]), 'txt', budget), 'unsupported_media_type', 'no_match');
  });

  it('텍스트 내용이라도 허용 텍스트 확장자 밖이면 extension_mismatch가 아니라 415 unsupported', () => {
    for (const ext of ['html', 'svg', 'js', '']) {
      expectReject(() => classify(Buffer.from('<svg/>'), ext, budget), 'unsupported_media_type', 'text_extension');
    }
  });
});

describe('classify — 단일 일치 규칙(폴리글랏)', () => {
  it('ZIP 안에 word/document.xml과 xl/workbook.xml이 함께 있으면 polyglot', () => {
    const zip = buildZip(docxEntries([{ name: 'xl/workbook.xml' }]));
    expect(binaryMatches(zip, budget)).toHaveLength(2);
    expectReject(() => classify(zip, 'docx', budget), 'unsupported_media_type', 'polyglot');
  });

  it('OOXML 3종 파트가 모두 있으면 polyglot', () => {
    const zip = buildZip(docxEntries([{ name: 'xl/workbook.xml' }, { name: 'ppt/presentation.xml' }]));
    expect(binaryMatches(zip, budget)).toHaveLength(3);
    expectReject(() => classify(zip, 'pptx', budget), 'unsupported_media_type', 'polyglot');
  });

  it('HWPX + OOXML 이중 해석 ZIP은 polyglot', () => {
    const zip = buildZip(hwpxEntries([{ name: '[Content_Types].xml' }, { name: 'word/document.xml' }]));
    expectReject(() => classify(zip, 'hwpx', budget), 'unsupported_media_type', 'polyglot');
  });

  it('OLE에 WordDocument와 Workbook이 함께 있으면 polyglot', () => {
    expectReject(() => classify(buildOle([...docTree(), ...xlsTree()]), 'doc', budget), 'unsupported_media_type', 'polyglot');
  });

  it('HWP 구조 + PowerPoint Document 스트림은 polyglot', () => {
    expectReject(() => classify(buildOle([...hwpTree(), ...pptTree()]), 'hwp', budget), 'unsupported_media_type', 'polyglot');
  });

  it('%PDF- 뒤에 ZIP을 붙이면(끝 EOCD 서명) pdf_zip_polyglot', () => {
    const polyglot = buildZip(docxEntries(), { prefix: pdfBytes() });
    expectReject(() => classify(polyglot, 'pdf', budget), 'unsupported_media_type', 'pdf_zip_polyglot');
    expectReject(() => binaryMatches(polyglot, budget), 'unsupported_media_type', 'pdf_zip_polyglot');
  });

  it('PDF 본문 안 EOCD 서명이 끝 스캔 창 밖이면 PDF로 받는다', () => {
    const far = Buffer.concat([pdfBytes(), Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(70_000, 0x20)]);
    expect(classifyFile(far, 'pdf').mime).toBe(PDF);
  });

  it('이진 판정기 하나라도 일치하면 텍스트로 보지 않는다(%PDF- 텍스트는 .txt여도 PDF)', () => {
    const match = classifyFile(Buffer.from('%PDF-1.4 just text', 'latin1'), 'txt');
    expect(match.mime).toBe(PDF);
    expect(checkExtension(match, 'txt')).toEqual({ ok: false, code: 'extension_mismatch' });
  });
});

describe('classify — ZIP64·암호화·엔트리 이름', () => {
  it('ZIP64 로케이터가 있는 OOXML은 zip64', () => {
    expectReject(() => classify(buildZip(docxEntries(), { zip64Locator: true }), 'docx', budget), 'unsupported_media_type', 'zip64');
  });

  it('EOCD 필드 0xFFFF(ZIP64 표지)는 zip64', () => {
    expectReject(() => classify(buildZip(xlsxEntries(), { declaredEntries: 0xffff }), 'xlsx', budget), 'unsupported_media_type', 'zip64');
  });

  it('암호화 플래그 엔트리가 있는 OOXML·HWPX는 encrypted_document', () => {
    expectReject(() => classify(buildZip(docxEntries([{ name: 'word/x.xml', flags: 1 }])), 'docx', budget), 'encrypted_document', 'zip_encrypted');
    expectReject(() => classify(buildZip(hwpxEntries([{ name: 'Contents/s.xml', flags: 1 }])), 'hwpx', budget), 'encrypted_document', 'zip_encrypted');
  });

  it('OLE 안 암호 걸린 OOXML(EncryptionInfo·EncryptedPackage)은 encrypted_document', () => {
    expectReject(() => classify(buildOle(encryptedTree()), 'docx', budget), 'encrypted_document', 'ole_encrypted');
    expectReject(() => classify(buildOle([oleStream('EncryptedPackage')]), 'xlsx', budget), 'encrypted_document', 'ole_encrypted');
    expectReject(() => classify(buildOle([...docTree(), oleStream('encryptioninfo')]), 'doc', budget), 'encrypted_document', 'ole_encrypted');
  });

  it('ZIP 엔트리 이름 중복·NUL은 415', () => {
    expectReject(() => classify(buildZip(docxEntries([{ name: '[Content_Types].xml' }])), 'docx', budget), 'unsupported_media_type', 'zip_name_dup');
    expectReject(() => classify(buildZip(xlsxEntries([{ name: 'xl/a\0b.xml' }])), 'xlsx', budget), 'unsupported_media_type', 'zip_name_nul');
  });

  it('OLE 엔트리 이름에 NUL이 있으면 ole_entry_name', () => {
    expectReject(() => classify(buildOle([oleStream('Work\u0000book')]), 'xls', budget), 'unsupported_media_type', 'ole_entry_name');
  });

  it('ZIP·OLE 서명이 맞는데 구조가 깨지면(EOCD 뒤 잔여·바이트 순서) 텍스트로 떨어지지 않고 415', () => {
    expectReject(() => classify(buildZip(docxEntries(), { trailing: Buffer.from('x') }), 'txt', budget), 'unsupported_media_type', 'zip_eocd');
    expectReject(() => classify(buildOle(docTree(), { byteOrder: 0xfeff }), 'doc', budget), 'unsupported_media_type', 'ole_byte_order');
  });
});

describe('checkExtension — 확장자-형식 일치', () => {
  it('판정 형식의 허용 확장자가 아니면 extension_mismatch', () => {
    const cases: readonly [Buffer, string][] = [
      [buildZip(docxEntries()), 'pdf'],
      [buildZip(docxEntries()), 'xlsx'],
      [buildZip(hwpxEntries()), 'hwp'],
      [buildOle(hwpTree()), 'hwpx'],
      [buildOle(docTree()), 'docx'],
      [buildOle(xlsTree()), 'xlsx'],
      [buildOle(pptTree()), 'pptx'],
      [pdfBytes(), 'docx'],
    ];
    for (const [bytes, ext] of cases) {
      expect(checkExtension(classifyFile(bytes, ext), ext)).toEqual({ ok: false, code: 'extension_mismatch' });
    }
  });

  it('텍스트 계열은 판정에 쓴 확장자 하나만 허용', () => {
    const md = classifyFile(Buffer.from('# x\n'), 'md');
    expect(checkExtension(md, 'md')).toEqual({ ok: true, ext: 'md' });
    expect(checkExtension(md, 'txt')).toEqual({ ok: false, code: 'extension_mismatch' });
  });

  it('미디어 확장자로 온 문서도 extension_mismatch', () => {
    expect(checkExtension(classifyFile(buildOle(docTree()), 'png'), 'png')).toEqual({ ok: false, code: 'extension_mismatch' });
  });
});
