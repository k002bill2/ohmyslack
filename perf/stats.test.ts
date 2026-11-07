import { describe, expect, it } from 'vitest';
import { percentile, percentileIndex, summarize, tallyDelivery } from './stats.ts';

describe('perf 통계(nearest-rank)', () => {
  it('percentileIndex는 ceil(p/100×n)−1이다', () => {
    expect(percentileIndex(100, 95)).toBe(94);
    expect(percentileIndex(100, 50)).toBe(49);
    expect(percentileIndex(20, 95)).toBe(18);
    expect(percentileIndex(19, 95)).toBe(18);
    expect(percentileIndex(1, 95)).toBe(0);
    expect(percentileIndex(10, 100)).toBe(9);
  });

  it('percentileIndex는 잘못된 입력을 거부한다', () => {
    expect(() => percentileIndex(0, 50)).toThrow();
    expect(() => percentileIndex(10, 0)).toThrow();
    expect(() => percentileIndex(10, 101)).toThrow();
  });

  it('summarize는 1..100에서 p50=50, p95=95, p99=99, max=100이고 입력을 바꾸지 않는다', () => {
    const values = Array.from({ length: 100 }, (_, i) => 100 - i);
    const copy = [...values];
    expect(summarize(values)).toEqual({ count: 100, min: 1, p50: 50, p95: 95, p99: 99, max: 100, mean: 50.5 });
    expect(values).toEqual(copy);
  });

  it('summarize는 빈 표본에서 undefined, 소수는 0.1 반올림', () => {
    expect(summarize([])).toBeUndefined();
    expect(summarize([1.26])).toMatchObject({ count: 1, p50: 1.3, p95: 1.3, max: 1.3 });
    expect(percentile([3, 7], 50)).toBe(3);
  });

  it('tallyDelivery는 누락·중복·예상 밖 수신을 센다', () => {
    const expected = new Map([
      ['m1', new Set([1, 2, 3])],
      ['m2', new Set([1, 2])],
    ]);
    const d = tallyDelivery(expected, [
      { message: 'm1', conn: 1 },
      { message: 'm1', conn: 2 },
      { message: 'm1', conn: 2 },
      { message: 'm1', conn: 0 },
      { message: 'm2', conn: 1 },
      { message: 'x', conn: 1 },
    ]);
    expect(d).toEqual({ expected: 5, delivered: 3, missing: 2, duplicates: 1, unexpected: 2 });
  });
});
