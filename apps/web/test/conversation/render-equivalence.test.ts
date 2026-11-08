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

function randomBody(next: () => number, fragments: readonly string[] = FRAGMENTS): string {
  const length = Math.floor(next() * 120);
  return Array.from({ length }, () => fragments[Math.floor(next() * fragments.length)] ?? '').join('');
}

/**
 * FR-MSG-10 채택 후 parseBody 동치는 서식 문법이 없는 입력에서만 성립한다(서식 문법은 의미가 바뀐 입력).
 * 인라인 백틱은 이제 인라인 코드라 줄 단위 fence(줄 시작 ```)로만 바꿔 fence 분기 커버리지를 유지한다.
 */
const STABLE_FRAGMENTS: readonly string[] = FRAGMENTS.filter((f) => !f.includes('`')).concat(['\n```\n', '\n```ts\n', '\n  ```\n']);
const BLOCK_MARK = /^(#{1,3} +\S|[-*] +\S|\d{1,9}\. +\S)/;

function hasFormatSyntax(body: string): boolean {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const inline = lines.some((line) => !/^\s*```/.test(line) && (line.includes('`') || line.includes('**') || /\[[^\]]+\]\(/.test(line)));
  return inline || lines.some((line) => BLOCK_MARK.test(line));
}

const EDGE_CASES: readonly string[] = [
  '', '\n', '```', '```\n```', '  ```js\nx\n  ```\ny', '```\na\n```\n```\nb', 'a:', 'a:b', ':b', '1:b', 'a1:b', '-a:b', 'xa:b c:d',
  'http://a.co/' + ')'.repeat(50), '(http://a.co/(x)))', 'http://a.co/]]][', 'http://a.co/}.', 'http://a.co/?!.,;:', 'https:',
  'https://', 'https:// x', 'see:https://example.com', 'a'.repeat(300), 'javascript:alert(1)', 'http://a.co"x',
];

describe('선형 파서 ↔ 수정 전 파서 출력 동치', () => {
  it.each(EDGE_CASES.map((body) => [JSON.stringify(body), body] as const))('경계 사례 %s', (_label, body) => {
    expect(parseBody(body)).toEqual(legacyParseBody(body));
  });

  it('무작위 입력 200개에서 linkify 결과가 구 구현과 같다', () => {
    const next = prng(0x0f1);
    for (let i = 0; i < 200; i += 1) {
      const body = randomBody(next);
      expect({ i, body, out: linkify(body) }).toEqual({ i, body, out: legacyLinkify(body) });
    }
  });

  it('서식 문법이 없는 무작위 입력에서 parseBody 결과가 구 구현과 같다(FR-MSG-10 이전 의미 보존)', () => {
    const next = prng(0x0f1);
    let compared = 0;
    for (let i = 0; i < 400; i += 1) {
      const body = randomBody(next, STABLE_FRAGMENTS);
      if (hasFormatSyntax(body)) continue;
      compared += 1;
      expect({ i, body, out: parseBody(body) }).toEqual({ i, body, out: legacyParseBody(body) });
    }
    expect(compared).toBeGreaterThanOrEqual(200);
  });

  it('FR-MSG-10: 링크 뒤 백틱 쌍은 이제 인라인 코드다(이전: 원문 텍스트)', () => {
    expect(parseBody('http://a.co`x`')).toEqual([
      {
        kind: 'paragraph',
        lines: [[{ kind: 'link', text: 'http://a.co', href: 'http://a.co/' }, { kind: 'code', text: 'x' }]],
      },
    ]);
  });
});
