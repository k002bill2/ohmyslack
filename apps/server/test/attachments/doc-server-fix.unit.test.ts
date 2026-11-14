import { describe, expect, it } from 'vitest';
import { DocSniffError, type SniffBudget } from '../../src/modules/attachments/doc-budget.js';
import { classify } from '../../src/modules/attachments/doc-sniff.js';
import { listOle } from '../../src/modules/attachments/ole-list.js';
import { judge } from '../../src/modules/attachments/service.js';
import { ATTACHMENT_DOC_MIMES, ATTACHMENT_TEXT_MIMES } from '../../src/shared.js';
import { buildOle, docTree } from './fixtures/ole-builder.js';
import { buildZip, docxEntries, pptxEntries, xlsxEntries } from './fixtures/zip-builder.js';

/** W-26 Codex r1 지적 회귀(TRD §6-1-1 (1)·(2)·(4)·(5)). */
const budget: SniffBudget = { now: () => 0, deadline: 1000 };
const clock = (): number => 0;
const [, , DOCM, , XLSM, , PPTM] = ATTACHMENT_DOC_MIMES;

function judgeStatus(declared: string, bytes: Buffer, filename: string | undefined): { status: number; code: string } | 'ok' {
  try {
    judge(declared, bytes, filename, clock);
    return 'ok';
  } catch (error) {
    const e = error as { statusCode?: number; code?: string };
    return { status: e.statusCode ?? 500, code: String(e.code) };
  }
}

function oleReason(b: Buffer): string | undefined {
  try {
    listOle(b, budget);
    return undefined;
  } catch (error) {
    if (!(error instanceof DocSniffError)) throw error;
    return error.reason;
  }
}

describe('P3 허용목록 밖 확장자(프로토타입 속성)', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])('확장자 %s는 text_extension 415(500 아님)', (ext) => {
    expect(() => classify(Buffer.from('hello\n'), ext, budget)).toThrow(DocSniffError);
    expect(judgeStatus('application/octet-stream', Buffer.from('hello\n'), `a.${ext}`)).toEqual({ status: 415, code: 'unsupported_media_type' });
  });
});

describe('P2 매크로 OOXML 선언 MIME 대소문자', () => {
  const cases = [
    { bytes: buildZip(docxEntries([{ name: 'word/vbaProject.bin' }])), mime: DOCM, name: 'a.docm' },
    { bytes: buildZip(xlsxEntries([{ name: 'xl/vbaProject.bin' }])), mime: XLSM, name: 'a.xlsm' },
    { bytes: buildZip(pptxEntries([{ name: 'ppt/vbaProject.bin' }])), mime: PPTM, name: 'a.pptm' },
  ];
  it.each(cases)('$name 실제 MIME($mime) 선언은 통과하고 저장 MIME은 표 그대로', ({ bytes, mime, name }) => {
    // 라우트는 선언 Content-Type을 소문자로 바꿔 넘긴다(declaredType).
    const judged = judge(String(mime).toLowerCase(), bytes, name, clock);
    expect(judged.mime).toBe(mime);
    expect(judged.hasMacros).toBe(true);
  });
});

describe('P3 텍스트 계열 파일명 헤더 누락', () => {
  it.each([...ATTACHMENT_TEXT_MIMES])('%s 선언 + 파일명 헤더 없음 → 400', (mime) => {
    expect(judgeStatus(mime, Buffer.from('a,b\n'), undefined)).toEqual({ status: 400, code: 'invalid_request' });
  });
});

/** 헤더 FAT 개수(0x2c)와 헤더 DIFAT 칸(0x4c~)을 고친 사본. */
function withFatHeader(b: Buffer, ids: readonly number[]): Buffer {
  const out = Buffer.from(b);
  out.writeUInt32LE(ids.length, 0x2c);
  ids.forEach((id, i) => out.writeUInt32LE(id, 0x4c + i * 4));
  return out;
}

describe('P2 OLE FAT 할당 상한', () => {
  const base = buildOle(docTree());

  it('같은 FAT 섹터를 두 번 참조하면 ole_fat_dup 415', () => {
    // FAT 2개가 개수 상한 안에 들도록 섹터 128개를 넘는 파일(큰 스트림 하나).
    const big = buildOle([{ name: 'WordDocument', type: 'stream', data: Buffer.alloc(80_000, 0x41) }]);
    expect(oleReason(big)).toBeUndefined();
    expect(oleReason(withFatHeader(big, [0, 0]))).toBe('ole_fat_dup');
  });

  it('파일 섹터 수로 필요한 수보다 많은 FAT 섹터(서로 다른 유효 번호)는 ole_fat_count 415', () => {
    const fileSectors = (base.length - 512) / 512;
    expect(fileSectors).toBeGreaterThanOrEqual(3);
    expect(oleReason(withFatHeader(base, [0, 1, 2]))).toBe('ole_fat_count');
  });

  it('FAT 테이블 항목 수는 파일 섹터 수 이하로 할당된다', () => {
    const listing = listOle(base, budget);
    expect(listing).toBeDefined();
    expect(listing?.fat.length).toBeLessThanOrEqual(listing?.fileSectors ?? 0);
  });

  it('FAT·미니 FAT 복사도 섹터마다 단계 예산을 센다', () => {
    // docTree: 디렉터리 체인 1 + 미니 FAT 체인 1(순회) + FAT 섹터 1 + 미니 FAT 섹터 1(복사) = 4단계.
    expect(listOle(base, budget)?.steps).toBe(4);
  });
});
