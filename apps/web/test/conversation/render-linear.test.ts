import { beforeAll, describe, expect, it } from 'vitest';
import { parseBody } from '../../src/features/conversation/render.js';

/**
 * FR-MSG-10 보조(F-1 회귀): 서식 파서는 입력 길이에 선형이어야 한다.
 * 절대 ms를 단언하지 않고(CI 편차), 1,000/2,000/4,000자 처리 시간 비율로 판정한다.
 * 선형이면 4,000/1,000 ≈ 4, 2차면 ≈ 16. 잡음 흡수를 위해 반복 배치 최솟값과 상한 8을 쓴다.
 */
const BATCH = 20;
const RUNS = 7;
const MAX_RATIO = 8;

function batchMs(body: string): number {
  const start = performance.now();
  for (let i = 0; i < BATCH; i += 1) parseBody(body);
  return performance.now() - start;
}

/**
 * 1k·2k·4k를 번갈아 RUNS번 재고 각 길이의 최솟값을 쓴다. GC·JIT 단계 전환·coverage 계측 잡음은 시간을 늘리기만 하고,
 * 교차 측정이라 한 길이만 잡음 구간에 몰리지 않는다.
 */
function interleavedMinMs(bodies: readonly string[]): readonly number[] {
  const mins = bodies.map(() => Number.POSITIVE_INFINITY);
  for (let r = 0; r < RUNS; r += 1) {
    bodies.forEach((body, k) => {
      mins[k] = Math.min(mins[k] ?? Number.POSITIVE_INFINITY, batchMs(body));
    });
  }
  return mins;
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
  ['[`**`]( 반복(링크 라벨 백틱, 닫히지 않은 링크)', '[`**`]('],
  ['[`](https://a.co) ** 반복(링크 라벨 백틱 + 굵게 닫기)', '[`](https://a.co) ** '],
  ['**a [`**`]( 반복(굵게 안 링크 모양 백틱)', '**a [`**`]( '],
];

describe('FR-MSG-10 4,000자 최악 입력 선형 시간', () => {
  // 모든 최악 입력 경로를 미리 최적화 단계까지 데워 첫 사례만 JIT 전환 비용을 떠안지 않게 한다.
  beforeAll(() => {
    for (let r = 0; r < 5; r += 1) for (const [, unit] of WORST) batchMs(repeatTo(unit, 4000));
  });

  it.each(WORST)('FR-MSG-10 %s: 4,000자/1,000자 시간 비율 ≤ 8', (_name, unit) => {
    const [t1 = 0, t2 = 0, t4 = 0] = interleavedMinMs([repeatTo(unit, 1000), repeatTo(unit, 2000), repeatTo(unit, 4000)]);
    expect(repeatTo(unit, 4000)).toHaveLength(4000);
    // 너무 빨라 타이머 분해능 아래면 비율이 무의미하므로 바닥값을 둔다.
    const floor = 0.05;
    const ratio = Math.max(t4, floor) / Math.max(t1, floor);
    console.info(`[render-linear] ${_name}: 1k=${t1.toFixed(3)}ms 2k=${t2.toFixed(3)}ms 4k=${t4.toFixed(3)}ms ratio=${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(MAX_RATIO);
  });
});
