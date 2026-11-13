import { describe, expect, it } from 'vitest';
import { DocSniffError, type SniffBudget } from '../../src/modules/attachments/doc-budget.js';
import { classify, type DocMatch } from '../../src/modules/attachments/doc-sniff.js';
import {
  ATTACHMENT_DOC_MIMES,
  ATTACHMENT_TEXT_MIMES,
  DOC_OLE_MAX_DIR_ENTRIES,
  DOC_OLE_MAX_DIR_SECTORS,
  DOC_SNIFF_DEADLINE_MS,
  DOC_ZIP_MAX_CD_BYTES,
  DOC_ZIP_MAX_ENTRIES,
  DOC_ZIP_MAX_NAME_BYTES,
} from '../../src/shared.js';
import { buildOle, docTree, hwpTree, oleStream, xlsTree, type OleNode } from './fixtures/ole-builder.js';
import { buildZip, docxEntries, type ZipBuildEntry } from './fixtures/zip-builder.js';

/**
 * 판정기 자원 상한(정본: TRD §6-1-1 (2) — 단계 상한이 1차 통제, 벽시계 `DOC_SNIFF_DEADLINE_MS`는 보조). 진입점 `classify`를 거쳐
 * 상한 초과가 DocSniffError(→ 415 unsupported_media_type)로 끝나는지, 상한 검사가 본문(중앙 디렉터리)을 읽기 전인지 본다.
 * 미검증: `DOC_OLE_MAX_CHAIN_STEPS`는 v3 기준 약 25 MiB 파일 + 109칸 넘는 DIFAT 체인이 있어야 닿아 단위 픽스처로 만들지 않는다.
 */
const [PDF, DOCX, , , , , , , HWP, DOC, XLS] = ATTACHMENT_DOC_MIMES;
const [, , CSV] = ATTACHMENT_TEXT_MIMES;
const budget: SniffBudget = { now: () => 0, deadline: DOC_SNIFF_DEADLINE_MS };

const errorOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected throw');
};

const expectUnsupported = (fn: () => unknown, reason: string): void => {
  const err = errorOf(fn);
  expect(err).toBeInstanceOf(DocSniffError);
  expect(err).toMatchObject({ code: 'unsupported_media_type', reason });
};

const mimeOf = (m: DocMatch): string => (m.kind === 'file' ? m.mime : m.media.mime);
const filler = (count: number): ZipBuildEntry[] => Array.from({ length: count }, (_, i) => ({ name: `f/${i}.xml` }));
const emptyStreams = (count: number): OleNode[] => Array.from({ length: count }, (_, i) => oleStream(`s${i}`, Buffer.alloc(0)));

/** 시작 시각 t0에서 호출할 때마다 `stepMs`씩 앞으로 가는 가짜 시계. 호출 횟수를 센다. */
function fakeClock(stepMs: number, t0 = 5_000): { budget: SniffBudget; calls: () => number } {
  let n = 0;
  return {
    budget: { now: () => t0 + stepMs * n++, deadline: t0 + DOC_SNIFF_DEADLINE_MS },
    calls: () => n,
  };
}

describe('ZIP 자원 상한(classify 경유)', () => {
  it('엔트리 수 상한까지는 판정, 하나 넘으면 zip_entries', () => {
    const atLimit = buildZip(docxEntries(filler(DOC_ZIP_MAX_ENTRIES - 2)));
    expect(mimeOf(classify(atLimit, 'docx', budget))).toBe(DOCX);
    expectUnsupported(() => classify(buildZip(docxEntries(filler(DOC_ZIP_MAX_ENTRIES - 1))), 'docx', budget), 'zip_entries');
  });

  it('선언 엔트리 수 초과는 중앙 디렉터리를 읽기 전에 거부(CD를 쓰레기로 덮어도 같은 사유)', () => {
    const zip = buildZip(docxEntries(), { declaredEntries: DOC_ZIP_MAX_ENTRIES + 1 });
    const cdOffset = zip.readUInt32LE(zip.length - 6);
    zip.fill(0xaa, cdOffset, zip.length - 22);
    expectUnsupported(() => classify(zip, 'docx', budget), 'zip_entries');
  });

  it('선언 중앙 디렉터리 크기 상한 초과는 zip_cd_bytes', () => {
    expectUnsupported(() => classify(buildZip(docxEntries(), { cdSizeDelta: DOC_ZIP_MAX_CD_BYTES }), 'docx', budget), 'zip_cd_bytes');
  });

  it('엔트리 이름 바이트 상한까지는 판정, 넘으면 zip_name_bytes', () => {
    const name = (n: number): string => `x/${'a'.repeat(n - 2)}`;
    expect(mimeOf(classify(buildZip(docxEntries([{ name: name(DOC_ZIP_MAX_NAME_BYTES) }])), 'docx', budget))).toBe(DOCX);
    expectUnsupported(() => classify(buildZip(docxEntries([{ name: name(DOC_ZIP_MAX_NAME_BYTES + 1) }])), 'docx', budget), 'zip_name_bytes');
  });
});

describe('OLE 자원 상한(classify 경유)', () => {
  it('디렉터리 섹터 상한까지는 판정, 넘으면 ole_dir_sectors', () => {
    expect(mimeOf(classify(buildOle(xlsTree(), { extraDirSectors: DOC_OLE_MAX_DIR_SECTORS - 1 }), 'xls', budget))).toBe(XLS);
    expectUnsupported(() => classify(buildOle(xlsTree(), { extraDirSectors: DOC_OLE_MAX_DIR_SECTORS }), 'xls', budget), 'ole_dir_sectors');
  });

  it('디렉터리 엔트리 상한(루트 포함)까지는 판정, 넘으면 ole_dir_entries', () => {
    // v4(섹터당 32엔트리): 섹터 상한보다 엔트리 상한이 먼저 걸린다. 루트 + Workbook = 2.
    const atLimit = buildOle([...xlsTree(), ...emptyStreams(DOC_OLE_MAX_DIR_ENTRIES - 2)], { major: 4 });
    expect(mimeOf(classify(atLimit, 'xls', budget))).toBe(XLS);
    const over = buildOle([...xlsTree(), ...emptyStreams(DOC_OLE_MAX_DIR_ENTRIES - 1)], { major: 4 });
    expectUnsupported(() => classify(over, 'xls', budget), 'ole_dir_entries');
  });

  it('FAT 순환(디렉터리 체인이 자기 자신을 가리킴)은 즉시 ole_cycle', () => {
    expectUnsupported(() => classify(buildOle(docTree(), { cyclicFat: true }), 'doc', budget), 'ole_cycle');
    expectUnsupported(() => classify(buildOle(hwpTree(), { cyclicFat: true, major: 4 }), 'hwp', budget), 'ole_cycle');
  });

  it('형제 사슬 순환(디렉터리 트리)도 ole_cycle', () => {
    const b = buildOle(docTree());
    const firstChildOff = 512 * 2 + 128; // FAT 1섹터 뒤 디렉터리 섹터의 엔트리 1
    b.writeUInt32LE(1, firstChildOff + 0x48);
    expectUnsupported(() => classify(b, 'doc', budget), 'ole_cycle');
  });

  it('FAT 섹터 번호가 파일 섹터 수 밖이면 ole_sector_range', () => {
    expectUnsupported(() => classify(buildOle(docTree(), { fatSectorOutOfRange: true }), 'doc', budget), 'ole_sector_range');
  });
});

describe('벽시계 보조 상한 — 가짜 시계', () => {
  it('대조군: 멈춘 시계(now = t0)면 같은 픽스처가 정상 판정된다', () => {
    const frozen: SniffBudget = { now: () => 5_000, deadline: 5_000 + DOC_SNIFF_DEADLINE_MS };
    expect(mimeOf(classify(buildOle(hwpTree()), 'hwp', frozen))).toBe(HWP);
    expect(mimeOf(classify(buildZip(docxEntries(filler(300))), 'docx', frozen))).toBe(DOCX);
  });

  it('경계: now()가 정확히 deadline이면 통과(초과일 때만 거부)', () => {
    const atDeadline: SniffBudget = { now: () => 5_000 + DOC_SNIFF_DEADLINE_MS, deadline: 5_000 + DOC_SNIFF_DEADLINE_MS };
    expect(mimeOf(classify(buildOle(hwpTree()), 'hwp', atDeadline))).toBe(HWP);
  });

  it('HWP: 목록 단계 확인은 통과, FileHeader 앞부분 읽기 직전에 시계가 deadline을 넘으면 sniff_deadline', () => {
    const clock = fakeClock(DOC_SNIFF_DEADLINE_MS + 1);
    expectUnsupported(() => classify(buildOle(hwpTree()), 'hwp', clock.budget), 'sniff_deadline');
    expect(clock.calls()).toBe(2);
  });

  it('작은 .doc는 목록 단계 확인 1회뿐이라 같은 시계로도 판정된다', () => {
    const clock = fakeClock(DOC_SNIFF_DEADLINE_MS + 1);
    expect(mimeOf(classify(buildOle(docTree()), 'doc', clock.budget))).toBe(DOC);
    expect(clock.calls()).toBe(1);
  });

  it('ZIP: 256 엔트리마다 확인하고, 두 번째 확인에서 deadline을 넘으면 sniff_deadline', () => {
    const clock = fakeClock(DOC_SNIFF_DEADLINE_MS + 1);
    expectUnsupported(() => classify(buildZip(docxEntries(filler(300))), 'docx', clock.budget), 'sniff_deadline');
    expect(clock.calls()).toBe(2);
  });

  it('시작부터 deadline이 지났으면 OLE는 목록을 읽기 전에 sniff_deadline', () => {
    const late: SniffBudget = { now: () => 1, deadline: 0 };
    expectUnsupported(() => classify(buildOle(xlsTree()), 'xls', late), 'sniff_deadline');
  });

  it('시계를 쓰지 않는 PDF·텍스트 판정은 deadline과 무관', () => {
    const late: SniffBudget = { now: () => 1, deadline: 0 };
    expect(mimeOf(classify(Buffer.from('%PDF-1.7\n', 'latin1'), 'pdf', late))).toBe(PDF);
    expect(mimeOf(classify(Buffer.from('a,b\n'), 'csv', late))).toBe(CSV);
  });
});
