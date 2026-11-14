import { describe, expect, it } from 'vitest';
import type { SniffBudget } from '../../src/modules/attachments/doc-budget.js';
import { checkExtension, classify, ooxmlHasMacros, type DocMatch } from '../../src/modules/attachments/doc-sniff.js';
import { ATTACHMENT_DOC_MIMES } from '../../src/shared.js';
import {
  buildOle,
  docTree,
  hwpTree,
  macrosStorage,
  oleStorage,
  oleStream,
  pptTree,
  vbaProjectCurStorage,
  vbaStorage,
  xlsTree,
} from './fixtures/ole-builder.js';
import { buildZip, docxEntries, hwpxEntries, pptxEntries, xlsxEntries } from './fixtures/zip-builder.js';

/**
 * 매크로 감지 × 확장자(정본: TRD §6-1-1 (3) `has_macros`, (4) 확장자-형식 일치 — 매크로 OOXML은 `.docm/.xlsm/.pptm`만,
 * x 확장자로 오면 `macro_extension_mismatch`(ADR-002 §4-3-1). 매크로 없는 OOXML은 x·m 둘 다 허용하고 원래 확장자 유지).
 */
const [, DOCX, DOCM, XLSX, XLSM, PPTX, PPTM, HWPX, HWP, DOC, XLS, PPT] = ATTACHMENT_DOC_MIMES;
const budget: SniffBudget = { now: () => 0, deadline: 1000 };
type FileMatch = Extract<DocMatch, { kind: 'file' }>;

const classifyFile = (b: Buffer, ext: string): FileMatch => {
  const m = classify(b, ext, budget);
  if (m.kind !== 'file') throw new Error('expected file match');
  return m;
};

const MISMATCH = { ok: false, code: 'extension_mismatch' } as const;
const MACRO_MISMATCH = { ok: false, code: 'macro_extension_mismatch' } as const;

describe('OOXML 매크로 감지 → 매크로형 MIME·확장자', () => {
  const cases = [
    { label: 'Word vbaProject.bin', bytes: () => buildZip(docxEntries([{ name: 'word/vbaProject.bin' }])), mime: DOCM, m: 'docm', x: 'docx' },
    { label: 'Excel vbaProject.bin', bytes: () => buildZip(xlsxEntries([{ name: 'xl/vbaProject.bin' }])), mime: XLSM, m: 'xlsm', x: 'xlsx' },
    { label: 'Excel 4.0 매크로 시트', bytes: () => buildZip(xlsxEntries([{ name: 'xl/macrosheets/sheet1.xml' }])), mime: XLSM, m: 'xlsm', x: 'xlsx' },
    { label: 'PowerPoint vbaProject.bin', bytes: () => buildZip(pptxEntries([{ name: 'ppt/vbaProject.bin' }])), mime: PPTM, m: 'pptm', x: 'pptx' },
  ];

  it.each(cases)('$label: has_macros=true, m 확장자만 통과', ({ bytes, mime, m }) => {
    const match = classifyFile(bytes(), m);
    expect(match).toMatchObject({ mime, hasMacros: true, macroOoxml: true });
    expect(match.extensions).toEqual([m]);
    expect(checkExtension(match, m)).toEqual({ ok: true, ext: m });
  });

  it.each(cases)('$label: x 확장자로 오면 macro_extension_mismatch', ({ bytes, x }) => {
    expect(checkExtension(classifyFile(bytes(), x), x)).toEqual(MACRO_MISMATCH);
  });

  it('매크로 OOXML이 다른 형식 확장자로 오면 일반 extension_mismatch', () => {
    const docm = classifyFile(buildZip(docxEntries([{ name: 'word/vbaProject.bin' }])), 'doc');
    for (const ext of ['doc', 'xlsm', 'xlsx', 'pdf']) expect(checkExtension(docm, ext)).toEqual(MISMATCH);
  });

  it('이름 판정은 대소문자 무시·경로 위치 무관(vbaProject.bin으로 끝나면 감지)', () => {
    expect(ooxmlHasMacros(['WORD/VBAPROJECT.BIN'])).toBe(true);
    expect(ooxmlHasMacros(['custom/dir/vbaProject.bin'])).toBe(true);
    expect(ooxmlHasMacros(['XL/MacroSheets/sheet1.xml'])).toBe(true);
    expect(ooxmlHasMacros(['word/document.xml', 'word/vbaData.xml', 'xl/worksheets/sheet1.xml'])).toBe(false);
    expect(classifyFile(buildZip(docxEntries([{ name: 'WORD/VBAPROJECT.BIN' }])), 'docm').mime).toBe(DOCM);
  });
});

describe('매크로 없는 OOXML — x·m 확장자 모두 허용(원래 확장자 유지)', () => {
  const cases = [
    { label: 'docx', bytes: () => buildZip(docxEntries()), mime: DOCX, x: 'docx', m: 'docm' },
    { label: 'xlsx', bytes: () => buildZip(xlsxEntries()), mime: XLSX, x: 'xlsx', m: 'xlsm' },
    { label: 'pptx', bytes: () => buildZip(pptxEntries()), mime: PPTX, x: 'pptx', m: 'pptm' },
  ];

  it.each(cases)('$label: has_macros=false, 두 확장자 통과', ({ bytes, mime, x, m }) => {
    const match = classifyFile(bytes(), x);
    expect(match).toMatchObject({ mime, hasMacros: false, macroOoxml: false });
    expect(checkExtension(match, x)).toEqual({ ok: true, ext: x });
    expect(checkExtension(match, m)).toEqual({ ok: true, ext: m });
  });
});

describe('OLE 매크로 저장소 → has_macros', () => {
  it('.doc: Macros·_VBA_PROJECT_CUR·VBA 저장소가 어디 있든 true, 없으면 false', () => {
    expect(classifyFile(buildOle(docTree()), 'doc')).toMatchObject({ mime: DOC, hasMacros: false });
    expect(classifyFile(buildOle([...docTree(), macrosStorage()]), 'doc')).toMatchObject({ mime: DOC, hasMacros: true });
    expect(classifyFile(buildOle([...docTree(), vbaProjectCurStorage()]), 'doc').hasMacros).toBe(true);
    expect(classifyFile(buildOle([...docTree(), oleStorage('ObjectPool', [oleStorage('_1', [vbaStorage()])])]), 'doc').hasMacros).toBe(true);
    expect(classifyFile(buildOle([...docTree(), oleStorage('macros', [oleStream('PROJECT')])]), 'doc').hasMacros).toBe(true);
  });

  it('.doc: 같은 이름이라도 스트림이면 매크로 저장소로 보지 않는다', () => {
    expect(classifyFile(buildOle([...docTree(), oleStream('VBA')]), 'doc').hasMacros).toBe(false);
  });

  it('.xls·.ppt는 목록으로 부재를 증명할 수 없어 매크로 저장소가 없어도 true(보수 표시)', () => {
    expect(classifyFile(buildOle(xlsTree()), 'xls')).toMatchObject({ mime: XLS, hasMacros: true });
    expect(classifyFile(buildOle([...xlsTree(), vbaProjectCurStorage()]), 'xls')).toMatchObject({ mime: XLS, hasMacros: true });
    expect(classifyFile(buildOle(pptTree()), 'ppt')).toMatchObject({ mime: PPT, hasMacros: true });
  });

  it('OLE 매크로 문서는 OOXML 매크로 확장자로 오면 일반 extension_mismatch(전용 코드는 OOXML만)', () => {
    const doc = classifyFile(buildOle([...docTree(), macrosStorage()]), 'doc');
    expect(doc.macroOoxml).toBe(false);
    expect(checkExtension(doc, 'doc')).toEqual({ ok: true, ext: 'doc' });
    expect(checkExtension(doc, 'docm')).toEqual(MISMATCH);
    expect(checkExtension(doc, 'docx')).toEqual(MISMATCH);
    expect(checkExtension(classifyFile(buildOle(xlsTree()), 'xls'), 'xlsm')).toEqual(MISMATCH);
    expect(checkExtension(classifyFile(buildOle(pptTree()), 'ppt'), 'pptm')).toEqual(MISMATCH);
  });

  it('매크로 없는 .doc도 매크로 확장자(.docm)면 extension_mismatch', () => {
    expect(checkExtension(classifyFile(buildOle(docTree()), 'docm'), 'docm')).toEqual(MISMATCH);
  });
});

describe('한글 매크로(스크립트) → has_macros', () => {
  it('HWP: Scripts 저장소·VBA 저장소면 true, 없으면 false', () => {
    expect(classifyFile(buildOle(hwpTree()), 'hwp')).toMatchObject({ mime: HWP, hasMacros: false });
    expect(classifyFile(buildOle(hwpTree({ scripts: true })), 'hwp')).toMatchObject({ mime: HWP, hasMacros: true });
    expect(classifyFile(buildOle([...hwpTree(), vbaStorage()]), 'hwp').hasMacros).toBe(true);
  });

  it('HWPX: Scripts/ 아래 엔트리면 true, 없으면 false', () => {
    expect(classifyFile(buildZip(hwpxEntries()), 'hwpx')).toMatchObject({ mime: HWPX, hasMacros: false });
    expect(classifyFile(buildZip(hwpxEntries([{ name: 'Scripts/headerScripts' }])), 'hwpx')).toMatchObject({ mime: HWPX, hasMacros: true });
  });

  it('한글 매크로 문서도 확장자는 형식 고정(hwp/hwpx 1개) — 매크로 전용 코드 없음', () => {
    const hwp = classifyFile(buildOle(hwpTree({ scripts: true })), 'hwp');
    expect(hwp.macroOoxml).toBe(false);
    expect(checkExtension(hwp, 'hwp')).toEqual({ ok: true, ext: 'hwp' });
    expect(checkExtension(hwp, 'hwpx')).toEqual(MISMATCH);
  });
});

describe('매크로 개념이 없는 형식', () => {
  it('PDF·텍스트는 has_macros=false 고정', () => {
    expect(classifyFile(Buffer.from('%PDF-1.7\n/JavaScript', 'latin1'), 'pdf').hasMacros).toBe(false);
    expect(classifyFile(Buffer.from('Sub AutoOpen()\nEnd Sub\n'), 'txt').hasMacros).toBe(false);
  });
});
