import { describe, expect, it } from 'vitest';
import { parseBody } from '../../src/features/conversation/render.js';

/**
 * FR-MSG-10 보조(F-1 회귀): 서식 파서는 입력 길이에 선형이어야 한다.
 * 절대 ms를 단언하지 않고(CI 편차), 1,000/2,000/4,000자 처리 시간 비율로 판정한다.
 * 선형이면 4,000/1,000 ≈ 4, 2차면 ≈ 16. 잡음 흡수를 위해 반복 배치 최솟값과 상한 8을 쓴다.
 */
const BATCH = 20;
const RUNS = 7;
const MAX_RATIO = 8;

/** 배치 시간의 최솟값 — GC·스케줄링 잡음은 시간을 늘리기만 하므로 최솟값이 가장 안정적인 추정치다. */
function minMs(body: string): number {
  for (let i = 0; i < BATCH; i += 1) parseBody(body); // 워밍업(JIT)
  const samples = Array.from({ length: RUNS }, () => {
    const start = performance.now();
    for (let i = 0; i < BATCH; i += 1) parseBody(body);
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return samples[0] ?? Number.POSITIVE_INFINITY;
}

function repeatTo(unit: string, length: number): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

/** 닫히지 않은 패턴을 반복하는 최악 입력. 각 항목은 4,000자에서 서버 상한(MESSAGE_BODY_MAX)과 같다. */
export const WORST: readonly (readonly [string, string])[] = [
  ['* 반복', '*'],
  ['` 반복', '`'],
  ['[ 반복', '['],
  ['**x 반복(닫히지 않은 굵게)', '**x '],
  ['[a]( 반복(닫히지 않은 링크)', '[a]('],
  ['[a](http://a.co/[ 반복(긴 URL 후보)', '[a](http://a.co/'],
  ['`` 반복(빈 인라인 코드)', '`` '],
  ['** ** 반복(flanking 실패)', '** '],
  ['# - 1. 줄 반복', '# x\n- y\n1. z\n'],
  ['** `a` 반복(코드 건너뛰는 굵게 닫기)', '** `a` '],
  ['http://a.co/** 반복(자동 링크 안 서식 기호)', 'http://a.co/** '],
];

describe('FR-MSG-10 4,000자 최악 입력 선형 시간', () => {
  it.each(WORST)('FR-MSG-10 %s: 4,000자/1,000자 시간 비율 ≤ 8', (_name, unit) => {
    const t1 = minMs(repeatTo(unit, 1000));
    const t2 = minMs(repeatTo(unit, 2000));
    const t4 = minMs(repeatTo(unit, 4000));
    expect(repeatTo(unit, 4000)).toHaveLength(4000);
    // 너무 빨라 타이머 분해능 아래면 비율이 무의미하므로 바닥값을 둔다.
    const floor = 0.05;
    const ratio = Math.max(t4, floor) / Math.max(t1, floor);
    console.info(`[render-linear] ${_name}: 1k=${t1.toFixed(3)}ms 2k=${t2.toFixed(3)}ms 4k=${t4.toFixed(3)}ms ratio=${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(MAX_RATIO);
  });
});
