import { describe, expect, it } from 'vitest';
import { linkify, parseBody } from '../../src/features/conversation/render.js';
import { legacyLinkify, legacyParseBody } from './render-legacy.js';

/** 시드 고정 PRNG(mulberry32) — 실패 시 같은 입력을 재현할 수 있게 한다. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 파서 분기(스킴·괄호·문장부호·구분자·fence·줄바꿈·서로게이트)를 고루 건드리는 조각. */
const FRAGMENTS: readonly string[] = [
  'http://', 'https://', 'HTTPS://', 'javascript:', 'mailto:', 'a+b.c-d:', '1x:', 'x', 'ab', 'Z9', '+', '.', '-', ':', '/',
  'example.com', 'a.co', '/wiki/Function_(mathematics)', '(', ')', '[', ']', '{', '}', '.', ',', ';', '!', '?', "'", '"',
  '」', '』', '>', '<', '`', '```', '```ts', ' ', '  ', '\t', '\n', '\r\n', '\r', ' ', '　', ' ', '한글', '링크',
  '😀', '\ud83d', '%', '#', '?q=1', '&', '=', '@', '_', '~', '0', '123',
];

function randomBody(next: () => number): string {
  const length = Math.floor(next() * 120);
  return Array.from({ length }, () => FRAGMENTS[Math.floor(next() * FRAGMENTS.length)] ?? '').join('');
}

const EDGE_CASES: readonly string[] = [
  '', '\n', '```', '```\n```', '  ```js\nx\n  ```\ny', '```\na\n```\n```\nb', 'a:', 'a:b', ':b', '1:b', 'a1:b', '-a:b', 'xa:b c:d',
  'http://a.co/' + ')'.repeat(50), '(http://a.co/(x)))', 'http://a.co/]]][', 'http://a.co/}.', 'http://a.co/?!.,;:', 'https:',
  'https://', 'https:// x', 'see:https://example.com', 'a'.repeat(300), 'javascript:alert(1)', 'http://a.co"x', 'http://a.co`x`',
];

describe('선형 파서 ↔ 수정 전 파서 출력 동치', () => {
  it.each(EDGE_CASES.map((body) => [JSON.stringify(body), body] as const))('경계 사례 %s', (_label, body) => {
    expect(parseBody(body)).toEqual(legacyParseBody(body));
  });

  it('무작위 입력 200개에서 parseBody·linkify 결과가 구 구현과 같다', () => {
    const next = prng(0x0f1);
    for (let i = 0; i < 200; i += 1) {
      const body = randomBody(next);
      expect({ i, body, out: parseBody(body) }).toEqual({ i, body, out: legacyParseBody(body) });
      expect({ i, body, out: linkify(body) }).toEqual({ i, body, out: legacyLinkify(body) });
    }
  });
});
