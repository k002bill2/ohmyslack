import type pg from 'pg';
import { withTransaction } from '../../db/pool.js';
import { METRIC_STATEMENT_TIMEOUT_MS, type MetricDims, type MetricsStore } from './metrics.js';

/**
 * `metric_daily` Postgres 저장소(마이그레이션 0009). (day, event, dims) 유일 행에 count만 올린다(flush 1행 = +n).
 * dims는 jsonb라 키 순서와 무관하게 같은 조합이 한 행으로 모인다. 값은 모두 파라미터 바인딩이다.
 *
 * 쓰기 상한(QA-REPORT-2 v1_hang): 각 쿼리는 자기 트랜잭션 안에서 `statement_timeout`(트랜잭션 로컬, set_config)을
 * 기록기 상한(METRIC_WRITE_TIMEOUT_MS)보다 짧게 건다 — 잠금 대기·느린 문장은 DB가 취소(57014)하므로 기록기가 포기한 행이
 * 나중에 커밋되지 않는다. pool 전역 설정은 바꾸지 않는다(일반 요청 경로 불변).
 * 연결 획득(pool.connect) 대기는 pg 쪽 상한이 없으므로 기록기 상한이 끊고, 늦게 연결을 얻으면 signal을 보고 쓰기 전에 포기한다.
 * 남는 경합: 기록기 상한이 COMMIT 진행 중에 닿으면 그 1행(+n)이 커밋되면서 재합산분과 겹칠 수 있다(과대 집계 최대 1행·1회).
 */
export interface PgMetricsStoreOptions {
  /** 기본 METRIC_STATEMENT_TIMEOUT_MS(테스트 주입용). */
  readonly statementTimeoutMs?: number;
}

export function createPgMetricsStore(pool: pg.Pool, options: PgMetricsStoreOptions = {}): MetricsStore {
  const statementTimeout = String(options.statementTimeoutMs ?? METRIC_STATEMENT_TIMEOUT_MS);
  const bounded = (signal: AbortSignal | undefined, sql: string, params: readonly unknown[]): Promise<pg.QueryResult> =>
    withTransaction(pool, async (client) => {
      // 늦게 연결을 얻었으면(기록기가 이미 포기·재합산) 쓰지 않는다. throw → withTransaction이 ROLLBACK.
      signal?.throwIfAborted();
      await client.query("SELECT set_config('statement_timeout', $1, true)", [statementTimeout]);
      const result = await client.query(sql, [...params]);
      signal?.throwIfAborted();
      return { commit: true, value: result };
    });
  return {
    async add(day: string, event: string, dims: MetricDims, n: number, signal?: AbortSignal) {
      await bounded(
        signal,
        `INSERT INTO metric_daily (day, event, dims, count) VALUES ($1::date, $2, $3::jsonb, $4)
         ON CONFLICT (day, event, dims) DO UPDATE SET count = metric_daily.count + EXCLUDED.count`,
        [day, event, JSON.stringify(dims), n],
      );
    },
    async pruneBefore(cutoffDay: string, signal?: AbortSignal) {
      const result = await bounded(signal, 'DELETE FROM metric_daily WHERE day < $1::date', [cutoffDay]);
      return result.rowCount ?? 0;
    },
  };
}
