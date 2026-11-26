import { describe, expect, it } from 'vitest';
import { toPreviewText } from '../../src/modules/messages/preview.js';
import { codePointLength, MESSAGE_PREVIEW_MAX } from '../../src/shared.js';

/** FR-CLIENT-05(TRD §6-2): SW가 세션으로 가져가는 알림 미리보기의 서버 평문화. 순수 함수. */
const hasLoneSurrogate = (s: string): boolean =>
  [...s].some((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp >= 0xd800 && cp <= 0xdfff;
  });

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

  it.each(['', '   \n\t', '```\n```', '**  **', '> ', '[](https://example.test)', '#  '])('평문이 비면 null (%j)', (input) => {
    expect(toPreviewText(input)).toBeNull();
  });
});
