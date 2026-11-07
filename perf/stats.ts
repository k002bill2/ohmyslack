/** FR-SYNC-01 (a) 지연 측정용 통계 순수 함수. 입력을 변경하지 않는다. */

export interface Summary {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

/** nearest-rank 백분위의 0 기반 인덱스: ceil(p/100 × n) − 1, [0, n−1]로 자른다. */
export function percentileIndex(n: number, p: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`표본 수가 양의 정수가 아님: ${n}`);
  if (!(p > 0 && p <= 100)) throw new Error(`백분위 범위 밖: ${p}`);
  const rank = Math.ceil((p / 100) * n);
  return Math.min(n - 1, Math.max(0, rank - 1));
}

/** 오름차순 정렬된 배열의 nearest-rank 백분위 값. */
export function percentile(sorted: readonly number[], p: number): number {
  return sorted[percentileIndex(sorted.length, p)] as number;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** 표본 요약(0.1ms 반올림). 표본이 없으면 undefined. */
export function summarize(values: readonly number[]): Summary | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((x, y) => x - y);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: round1(sorted[0] as number),
    p50: round1(percentile(sorted, 50)),
    p95: round1(percentile(sorted, 95)),
    p99: round1(percentile(sorted, 99)),
    max: round1(sorted[sorted.length - 1] as number),
    mean: round1(sum / sorted.length),
  };
}

export interface Receipt {
  readonly message: string;
  readonly conn: number;
}

export interface Delivery {
  /** 기대 (메시지, 수신 연결) 쌍 수. */
  readonly expected: number;
  /** 기대 쌍 중 1회 이상 받은 수. */
  readonly delivered: number;
  /** 기대 쌍 중 한 번도 받지 못한 수. */
  readonly missing: number;
  /** 같은 쌍을 두 번 이상 받은 초과 횟수 합. */
  readonly duplicates: number;
  /** 기대 목록에 없는 (메시지, 연결) 수신 수(예: 다른 대화·알 수 없는 메시지). */
  readonly unexpected: number;
}

/** 메시지별 기대 수신 연결 집합과 실제 수신 목록으로 누락·중복을 집계한다. */
export function tallyDelivery(expected: ReadonlyMap<string, ReadonlySet<number>>, receipts: readonly Receipt[]): Delivery {
  const counts = new Map<string, number>();
  let unexpected = 0;
  for (const r of receipts) {
    if (expected.get(r.message)?.has(r.conn) !== true) {
      unexpected += 1;
      continue;
    }
    const key = `${r.message}\u0000${r.conn}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = [...expected.values()].reduce((acc, s) => acc + s.size, 0);
  const delivered = counts.size;
  const duplicates = [...counts.values()].reduce((acc, c) => acc + (c - 1), 0);
  return { expected: total, delivered, missing: total - delivered, duplicates, unexpected };
}
