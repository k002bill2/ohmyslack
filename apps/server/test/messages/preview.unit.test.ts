import { describe, expect, it } from 'vitest';
import { toPreviewText } from '../../src/modules/messages/preview.js';
import { codePointLength, MESSAGE_BODY_MAX, MESSAGE_PREVIEW_MAX } from '../../src/shared.js';

/** FR-CLIENT-05(TRD §6-2): SW가 세션으로 가져가는 알림 미리보기의 서버 평문화. 순수 함수. */
const hasLoneSurrogate = (s: string): boolean =>
  [...s].some((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp >= 0xd800 && cp <= 0xdfff;
  });

/**
 * ReDoS 방어 시간 판정(부하 내성). 잡음(병렬 워커·GC·coverage)은 시간을 늘리기만 하므로, 상한 안 표본이 하나라도 나오면
 * 그 입력은 상한 안에 끝날 수 있다는 증거다 — 최대 TRIES번 재고 최솟값을 쓴다. 역추적 정규식은 매 표본이 수 초라
 * 최솟값도 상한을 넘는다(판별력 유지). 상한 10배를 넘는 표본은 재시도하지 않는다(red가 수십 초로 늘지 않게).
 */
const TRIES = 5;
function bestMs(work: () => void, boundMs: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < TRIES; i += 1) {
    const started = performance.now();
    work();
    const elapsed = performance.now() - started;
    best = Math.min(best, elapsed);
    if (best < boundMs || elapsed > boundMs * 10) break;
  }
  return best;
}

describe('FR-CLIENT-05 push 알림 미리보기 평문화(toPreviewText)', () => {
  it.each([
    ['굵게·기울임·취소선', '**굵게** 와 _기울임_ 그리고 ~~취소~~ *별표*', '굵게 와 기울임 그리고 취소 별표'],
    ['링크 [t](u) → t', '[문서](https://example.test/a) 보세요', '문서 보세요'],
    ['이미지 alt만', '![그림](https://example.test/a.png)', '그림'],
    ['헤더 #', '# 제목\n## 소제목', '제목 소제목'],
    ['인용 >', '> 인용문\n>> 둘째 줄', '인용문 둘째 줄'],
    ['목록 기호', '- 하나\n* 둘\n+ 셋\n1. 넷\n2) 다섯', '하나 둘 셋 넷 다섯'],
    ['코드 펜스', '```ts\nconst a = 1;\n```\n끝', 'const a = 1; 끝'],
    ['인라인 코드', '실행: `pnpm test`', '실행: pnpm test'],
    ['연속 공백·줄바꿈·앞뒤 공백', '  첫 줄\n\n\t둘째   줄  ', '첫 줄 둘째 줄'],
    ['식별자 밑줄·곱셈 별표 보존', 'user_id 값 a*b', 'user_id 값 a*b'],
    ['인용 안 목록', '> - 항목', '항목'],
    ['인라인 코드 안 표식 보존', '파일 `__init__.py` 와 `2 ** 3` 그리고 `[a](b)`', '파일 __init__.py 와 2 ** 3 그리고 [a](b)'],
    ['코드 펜스 안 표식 보존', '```\n# 헤더 아님\n- x **y** > z\n```', '# 헤더 아님 - x **y** > z'],
    ['코드 밖 서식은 계속 제거', '**굵게** `*별*` _끝_', '굵게 *별* 끝'],
  ])('%s', (_name, input, expected) => {
    expect(toPreviewText(input)).toBe(expected);
  });

  it('최대 100 code point: 경계값은 그대로, 초과하면 100자 + …', () => {
    const exact = '가'.repeat(MESSAGE_PREVIEW_MAX);
    expect(toPreviewText(exact)).toBe(exact);
    expect(toPreviewText(`${exact}나`)).toBe(`${exact}…`);
    expect(toPreviewText(`${'가'.repeat(MESSAGE_PREVIEW_MAX - 2)}\n\n\n나`)).toBe(`${'가'.repeat(MESSAGE_PREVIEW_MAX - 2)} 나`);
  });

  it('이모지(서로게이트 쌍)·한글을 code point로 세고 쌍 중간에서 자르지 않는다', () => {
    const out = toPreviewText('😀'.repeat(MESSAGE_PREVIEW_MAX + 5)) ?? '';
    expect(out).toBe(`${'😀'.repeat(MESSAGE_PREVIEW_MAX)}…`);
    expect(codePointLength(out)).toBe(MESSAGE_PREVIEW_MAX + 1);
    expect(hasLoneSurrogate(out)).toBe(false);
    const mixed = toPreviewText('한😀'.repeat(60)) ?? '';
    expect(codePointLength(mixed)).toBe(MESSAGE_PREVIEW_MAX + 1);
    expect(hasLoneSurrogate(mixed)).toBe(false);
  });

  it.each([
    ['백틱만', '`'.repeat(MESSAGE_BODY_MAX)],
    ['백틱 길이 섞임', Array.from({ length: 80 }, (_, i) => `${'`'.repeat(i + 1)}x`).join('').slice(0, MESSAGE_BODY_MAX)],
    ['펜스 줄 반복', '```\n'.repeat(MESSAGE_BODY_MAX / 4)],
    ['밑줄 강조 미완', '_a '.repeat(MESSAGE_BODY_MAX / 3)],
    ['별 강조 미완', '*a '.repeat(MESSAGE_BODY_MAX / 3)],
    ['링크 여는 괄호', '['.repeat(MESSAGE_BODY_MAX)],
    ['링크 미완', '[a]('.repeat(MESSAGE_BODY_MAX / 4)],
    ['인용 반복', '> '.repeat(MESSAGE_BODY_MAX / 2)],
  ])('본문 상한 길이의 악성 입력(%s)도 빠르게 끝난다(이벤트 루프 점유 방지)', (_name, input) => {
    expect(bestMs(() => toPreviewText(input), 100)).toBeLessThan(100);
  });

  it.each([
    ['[ 반복', '['.repeat(100_000)],
    ['*a 반복', '*a '.repeat(33_334)],
    ['_a 반복', '_a '.repeat(33_334)],
    ['[a]( 반복', '[a]('.repeat(25_000)],
  ])('10만 자 악성 입력(%s)은 200ms 안에 끝나고 결과는 null 또는 100 code point 이하(+…)', (_name, input) => {
    expect(bestMs(() => toPreviewText(input), 200)).toBeLessThan(200);
    const out = toPreviewText(input);
    expect(out === null || codePointLength(out) <= MESSAGE_PREVIEW_MAX + 1).toBe(true);
  });

  it('입력 상한 절단은 서로게이트 쌍을 깨지 않는다', () => {
    const out = toPreviewText('😀'.repeat(5_000)) ?? '';
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it('grapheme 단위 절단: ZWJ 가족·결합 문자·국기를 경계에서 분리하지 않는다', () => {
    const family = '👨‍👩‍👧‍👦'; // 7 code point 1 grapheme
    const out = toPreviewText(`${'가'.repeat(MESSAGE_PREVIEW_MAX - 3)}${family}`) ?? '';
    expect(out).toBe(`${'가'.repeat(MESSAGE_PREVIEW_MAX - 3)}…`);
    const combining = 'e' + String.fromCodePoint(0x301);
    const out2 = toPreviewText(`${'가'.repeat(MESSAGE_PREVIEW_MAX - 1)}${combining}`) ?? '';
    expect(out2).toBe(`${'가'.repeat(MESSAGE_PREVIEW_MAX - 1)}…`);
    const flag = '🇰🇷'; // 2 code point 1 grapheme
    const out3 = toPreviewText(`${'가'.repeat(MESSAGE_PREVIEW_MAX - 1)}${flag}`) ?? '';
    expect(out3).toBe(`${'가'.repeat(MESSAGE_PREVIEW_MAX - 1)}…`);
    // 경계에 정확히 들어가면 유지
    const fits = `${'가'.repeat(MESSAGE_PREVIEW_MAX - 2)}${flag}`;
    expect(toPreviewText(fits)).toBe(fits);
    expect(toPreviewText(`${fits}나`)).toBe(`${fits}…`);
  });

  it.each(['', '   \n\t', '```\n```', '**  **', '> ', '[](https://example.test)', '#  '])('평문이 비면 null (%j)', (input) => {
    expect(toPreviewText(input)).toBeNull();
  });
});
