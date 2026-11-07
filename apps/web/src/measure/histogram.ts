/** 표시 지연 측정 빌드 전용(W-10k C): 메모리 백분위 히스토그램. 디스크·로그·전송 없음. */

export interface StageStats {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly n: number;
}

export interface Histogram {
  readonly record: (ms: number) => void;
  readonly summary: () => StageStats;
  readonly reset: () => void;
}

/** 무한 증가 방지 상한. 부하 10분(5msg/s ≈ 3000건)을 넉넉히 덮는다. 넘으면 가장 오래된 표본부터 버린다. */
export const MAX_SAMPLES = 100_000;

const EMPTY: StageStats = Object.freeze({ p50: 0, p95: 0, p99: 0, max: 0, n: 0 });

/** nearest-rank 백분위: 오름차순 정렬 후 ceil(p/100·n)번째(1-기준) 값. 빈 배열은 0. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? 0;
}

export function summarize(samples: readonly number[]): StageStats {
  if (samples.length === 0) return EMPTY;
  const sorted = [...samples].sort((a, b) => a - b);
  return Object.freeze({
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
    n: sorted.length,
  });
}

export function createHistogram(cap: number = MAX_SAMPLES): Histogram {
  let samples: number[] = [];
  return {
    record(ms) {
      if (!Number.isFinite(ms)) return;
      samples.push(ms);
      if (samples.length > cap) samples = samples.slice(samples.length - cap);
    },
    summary: () => summarize(samples),
    reset() {
      samples = [];
    },
  };
}
