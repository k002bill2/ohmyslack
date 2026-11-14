import { describe, expect, it } from 'vitest';
import { attachmentDisposition } from '../../src/modules/attachments/filename.js';
import { ATTACHMENT_FILENAME_MAX_BYTES } from '../../src/shared.js';

/**
 * 다운로드 헤더 파일명의 NFD 길이 맞춤(TRD §6-1-1 (6)). iOS 「파일」은 저장 시 이름을 NFD로 바꾼 뒤 255바이트에서 자르므로
 * 헤더 이름을 미리 NFD ≤ 255바이트로 줄인다(음절 경계, 확장자 보존). 저장 이름(projection)은 그대로다.
 */
const nfdBytes = (value: string): number => Buffer.byteLength(value.normalize('NFD'), 'utf8');

function parse(header: string): { readonly fallback: string; readonly utf8: string } {
  const match = /^attachment; filename="([^"]*)"; filename\*=UTF-8''(\S+)$/u.exec(header);
  if (match === null) throw new Error(`헤더 형식: ${header}`);
  return { fallback: match[1] ?? '', utf8: decodeURIComponent(match[2] ?? '') };
}

// 실기 B2 재현형: NFC 255바이트 안, NFD로는 255바이트를 넘는 89자 `.docm`.
const LONG_DOCM = `2026년_하반기_조직개편_관련_부서별_인력배치_계획안_및_예산_검토_요청서_인사팀_총무팀_공동작성본_최종_수정본_회의자료_첨부_꼭_검토용_부탁드립니다.docm`;

describe('Content-Disposition NFD 길이 맞춤', () => {
  it('전제: 사례 이름은 89자, NFC로는 상한 안, NFD로는 상한 밖', () => {
    expect([...LONG_DOCM].length).toBe(89);
    expect(Buffer.byteLength(LONG_DOCM, 'utf8')).toBeLessThanOrEqual(ATTACHMENT_FILENAME_MAX_BYTES);
    expect(nfdBytes(LONG_DOCM)).toBeGreaterThan(ATTACHMENT_FILENAME_MAX_BYTES);
  });

  it('긴 한글 이름은 NFD ≤ 255바이트로 음절 경계에서 줄고 확장자를 유지한다', () => {
    const { fallback, utf8 } = parse(attachmentDisposition(LONG_DOCM));
    expect(nfdBytes(utf8)).toBeLessThanOrEqual(ATTACHMENT_FILENAME_MAX_BYTES);
    expect(utf8.endsWith('.docm')).toBe(true);
    expect(utf8.normalize('NFC')).toBe(utf8);
    const stem = utf8.slice(0, -'.docm'.length);
    expect(LONG_DOCM.startsWith(stem)).toBe(true);
    // 마지막 글자가 온전한 음절(호환·조합 자모 단독 없음).
    expect(stem).not.toMatch(/[ᄀ-ᇿ㄰-㆏]/u);
    expect(/[가-힣_0-9A-Za-z]$/u.test(stem)).toBe(true);
    // 한 음절을 더 넣으면 상한을 넘는다(최대한 보존).
    const next = [...LONG_DOCM.slice(stem.length)][0] ?? '';
    expect(nfdBytes(`${stem}${next}.docm`)).toBeGreaterThan(ATTACHMENT_FILENAME_MAX_BYTES);
    expect(Buffer.byteLength(fallback, 'utf8')).toBeLessThanOrEqual(ATTACHMENT_FILENAME_MAX_BYTES);
    expect(fallback.endsWith('.docm')).toBe(true);
  });

  it('NFD 상한 안의 이름은 그대로다', () => {
    for (const name of ['회의록 초안.docx', '분기 실적 집계.xlsx', 'report.pdf', '가'.repeat(40) + '.txt']) {
      expect(parse(attachmentDisposition(name)).utf8).toBe(name);
    }
  });

  it('결합 문자·이모지 ZWJ 시퀀스는 자소 경계에서만 자른다', () => {
    // NFC로 합쳐지지 않는 결합 문자(q + U+0307)와 가족 이모지(ZWJ 시퀀스)를 반복.
    const unit = 'q̇👨‍👩‍👧';
    const name = `${unit.repeat(20)}.txt`;
    expect(nfdBytes(name)).toBeGreaterThan(ATTACHMENT_FILENAME_MAX_BYTES);
    const { fallback, utf8 } = parse(attachmentDisposition(name));
    expect(nfdBytes(utf8)).toBeLessThanOrEqual(ATTACHMENT_FILENAME_MAX_BYTES);
    expect(utf8.endsWith('.txt')).toBe(true);
    const stem = utf8.slice(0, -'.txt'.length);
    const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(stem)].map((s) => s.segment);
    expect(segments.length).toBeGreaterThan(0);
    for (const [i, seg] of segments.entries()) expect(seg).toBe(i % 2 === 0 ? 'q̇' : '👨‍👩‍👧');
    expect(Buffer.byteLength(fallback, 'utf8')).toBeLessThanOrEqual(ATTACHMENT_FILENAME_MAX_BYTES);
  });

  it('확장자만 남길 만큼 긴 한 글자뿐이어도 확장자는 남는다', () => {
    const { utf8 } = parse(attachmentDisposition(`${'👨‍👩‍👧'.repeat(30)}.pdf`));
    expect(utf8.endsWith('.pdf')).toBe(true);
    expect(nfdBytes(utf8)).toBeLessThanOrEqual(ATTACHMENT_FILENAME_MAX_BYTES);
  });
});
