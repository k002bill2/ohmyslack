import type pg from 'pg';
import type { MetricDims, MetricsStore } from './metrics.js';

/**
 * `metric_daily` Postgres 저장소(마이그레이션 0009). (day, event, dims) 유일 행에 count만 올린다(flush 1행 = +n).
 * dims는 jsonb라 키 순서와 무관하게 같은 조합이 한 행으로 모인다. 값은 모두 파라미터 바인딩이다.
 */
export function createPgMetricsStore(pool: pg.Pool): MetricsStore {
  return {
    async add(day: string, event: string, dims: MetricDims, n: number) {
      await pool.query(
        `INSERT INTO metric_daily (day, event, dims, count) VALUES ($1::date, $2, $3::jsonb, $4)
         ON CONFLICT (day, event, dims) DO UPDATE SET count = metric_daily.count + EXCLUDED.count`,
        [day, event, JSON.stringify(dims), n],
      );
    },
    async pruneBefore(cutoffDay: string) {
      const result = await pool.query('DELETE FROM metric_daily WHERE day < $1::date', [cutoffDay]);
      return result.rowCount ?? 0;
    },
  };
}
