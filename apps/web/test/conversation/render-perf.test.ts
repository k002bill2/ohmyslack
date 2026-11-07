import { describe, expect, it } from 'vitest';
import { parseBody } from '../../src/features/conversation/render.js';

/**
 * F-1(SECURITY_REVIEW_P1) 회귀: 서버 상한(MESSAGE_BODY_MAX=4000) 안의 악성 본문이 메인 스레드를 오래 잡지 않아야 한다.
 * 판정: 3회 측정 중앙값 ≤ PARSE_BUDGET_MS. 선형 구현은 1 ms 안팎이라 CI 변동을 넉넉히 흡수한다.
 */
const PARSE_BUDGET_MS = 20;
const RUNS = 3;

function medianParseMs(body: string): number {
  parseBody(body); // 워밍업(JIT)
  const samples = Array.from({ length: RUNS }, () => {
    const start = performance.now();
    parseBody(body);
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return samples[Math.floor(RUNS / 2)] ?? Number.POSITIVE_INFINITY;
}

const MALICIOUS: readonly (readonly [string, string])[] = [
  ['링크 뒤 닫는 괄호 3988개(F-1 재현)', 'http://a.co/' + ')'.repeat(3988)],
  ['콜론 없는 4000자 단어(F-1 재현)', 'a'.repeat(4000)],
];

describe('F-1 본문 파서 DoS 회귀', () => {
  it.each(MALICIOUS)('%s: parseBody 중앙값이 20 ms 이하', (_name, body) => {
    expect(body.length).toBe(4000);
    expect(medianParseMs(body)).toBeLessThanOrEqual(PARSE_BUDGET_MS);
  });

  it('괄호 폭탄 링크는 짝 없는 닫는 괄호를 모두 떼어낸다', () => {
    const [block] = parseBody('http://a.co/' + ')'.repeat(3988));
    expect(block).toEqual({
      kind: 'paragraph',
      lines: [[{ kind: 'link', text: 'http://a.co/', href: 'http://a.co/' }, { kind: 'text', text: ')'.repeat(3988) }]],
    });
  });
});
