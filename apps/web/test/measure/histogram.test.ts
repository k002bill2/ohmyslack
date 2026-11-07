import { describe, expect, it } from 'vitest';
import { createHistogram, percentile, summarize } from '../../src/measure/histogram.js';

describe('W-10k C 측정 히스토그램', () => {
  it('1..100 표본에서 nearest-rank p50·p95·p99·max·n을 낸다', () => {
    const h = createHistogram();
    for (let i = 100; i >= 1; i -= 1) h.record(i);
    expect(h.summary()).toEqual({ p50: 50, p95: 95, p99: 99, max: 100, n: 100 });
  });

  it('빈 히스토그램은 모두 0이고 reset은 표본을 비운다', () => {
    const h = createHistogram();
    expect(h.summary()).toEqual({ p50: 0, p95: 0, p99: 0, max: 0, n: 0 });
    h.record(10);
    h.record(30);
    expect(h.summary()).toEqual({ p50: 10, p95: 30, p99: 30, max: 30, n: 2 });
    h.reset();
    expect(h.summary().n).toBe(0);
  });

  it('유한하지 않은 값은 버리고 상한을 넘으면 가장 오래된 표본부터 버린다', () => {
    const h = createHistogram(3);
    h.record(Number.NaN);
    h.record(Number.POSITIVE_INFINITY);
    [1, 2, 3, 4].forEach((v) => h.record(v));
    expect(h.summary()).toEqual({ p50: 3, p95: 4, p99: 4, max: 4, n: 3 });
  });

  it('percentile·summarize는 입력을 변경하지 않는다', () => {
    const samples = [5, 1, 3];
    expect(summarize(samples).p50).toBe(3);
    expect(samples).toEqual([5, 1, 3]);
    expect(percentile([], 50)).toBe(0);
    expect(percentile([7], 1)).toBe(7);
  });
});
