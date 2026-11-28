import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOG_CANARIES } from '../../../../tools/log-canaries.js';
import { METRIC_WRITE_TIMEOUT_MS, createMetricsRecorder, pruneMetrics } from '../../src/modules/ops/metrics.js';
import { createPgMetricsStore } from '../../src/modules/ops/metrics-store.js';
import { METRIC_ALLOWLIST } from '../../src/shared.js';
import { migratedSchema } from '../auth/bootstrap-harness.js';
import type { TestSchema } from '../support/test-db.js';

/** FR-OPS-03·TR-SEC-09: metric_daily는 일 단위 횟수만, 허용 필드만, 7일만 보관한다(마이그레이션 0009). */
let schema: TestSchema | undefined;

afterEach(async () => {
  await schema?.drop();
  schema = undefined;
});

interface DailyRow {
  readonly day: string;
  readonly event: string;
  readonly dims: Record<string, unknown>;
  readonly count: number;
}

async function rows(s: TestSchema): Promise<DailyRow[]> {
  const result = await s.pool.query<DailyRow>('SELECT day::text AS day, event, dims, count FROM metric_daily ORDER BY day, event, count');
  return result.rows;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 28, 9);

describe('metric_daily (Postgres)', () => {
  it('열은 day·event·dims·count 네 개뿐이다(식별자·본문을 담을 열 없음)', async () => {
    schema = await migratedSchema();
    const cols = await schema.pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'metric_daily' ORDER BY column_name",
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(['count', 'day', 'dims', 'event']);
  });

  it('같은 (일자, event, dims)는 한 행으로 count만 오르고, dims 키 순서와 무관하다', async () => {
    schema = await migratedSchema();
    const store = createPgMetricsStore(schema.pool);
    const metrics = createMetricsRecorder({ store, clock: () => T0 });
    metrics.record({ event: 'message_send_result', outcome: 'ok', conv_kind: 'dm', has_thread: false, duration_ms: 120 });
    metrics.record({ duration_ms: 200, has_thread: false, conv_kind: 'dm', outcome: 'ok', event: 'message_send_result' });
    metrics.record({ event: 'message_send_result', outcome: 'duplicate', conv_kind: 'dm', has_thread: false, duration_ms: 120 });
    await metrics.idle();
    expect(await rows(schema)).toEqual([
      { day: '2026-11-28', event: 'message_send_result', dims: { outcome: 'duplicate', conv_kind: 'dm', has_thread: false, duration_ms: 100 }, count: 1 },
      { day: '2026-11-28', event: 'message_send_result', dims: { outcome: 'ok', conv_kind: 'dm', has_thread: false, duration_ms: 100 }, count: 2 },
    ]);
  });

  it('카나리아(본문·토큰·ID)와 허용 밖 키는 저장되지 않고, 저장된 dims 키는 allowlist뿐이다', async () => {
    schema = await migratedSchema();
    const metrics = createMetricsRecorder({ store: createPgMetricsStore(schema.pool), clock: () => T0 });
    for (const canary of Object.values(LOG_CANARIES)) {
      metrics.record({ event: 'auth_denied', action: 'login', reason: canary, count: 1 });
      metrics.record({ event: 'push_send_result', outcome: 'sent', endpoint: canary });
      metrics.record({ event: 'bot_delivery_result', direction: 'in', outcome: 'ok', has_attachment: false, duration_ms: 1, message_id: canary });
    }
    metrics.record({ event: 'auth_denied', action: 'login', reason: 'bad_credentials', count: 1 });
    await metrics.idle();
    const stored = await rows(schema);
    expect(stored).toHaveLength(1);
    const dump = JSON.stringify(stored);
    for (const canary of Object.values(LOG_CANARIES)) expect(dump).not.toContain(canary);
    for (const row of stored) {
      expect(Object.keys(row.dims).sort()).toEqual([...METRIC_ALLOWLIST[row.event as keyof typeof METRIC_ALLOWLIST]].sort());
    }
  });

  it('계측 쿼리에는 서버측 statement_timeout이 걸린다: 다른 연결이 행을 잠그면 상한 안에 57014로 끝나고, 잠금 해제 후 재합산이 정확히 반영된다', async () => {
    schema = await migratedSchema();
    const store = createPgMetricsStore(schema.pool, { statementTimeoutMs: 200 });
    const onError = vi.fn();
    const metrics = createMetricsRecorder({ store, clock: () => T0, onError });
    metrics.record({ event: 'push_send_result', outcome: 'sent' });
    await metrics.idle();
    const locker = await schema.pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query("SELECT count FROM metric_daily WHERE event = 'push_send_result' FOR UPDATE");
      // 직접 호출: 잠금 대기가 DB에서 취소된다(기록기 상한 METRIC_WRITE_TIMEOUT_MS보다 훨씬 전에).
      const started = Date.now();
      const error: unknown = await store.add('2026-11-28', 'push_send_result', { outcome: 'sent' }, 1).catch((e: unknown) => e);
      expect((error as { code?: unknown }).code).toBe('57014');
      expect(Date.now() - started).toBeLessThan(METRIC_WRITE_TIMEOUT_MS);
      // 기록기 경로: 실패 → 재합산 + metric_write_failed.
      metrics.record({ event: 'push_send_result', outcome: 'sent' });
      metrics.record({ event: 'push_send_result', outcome: 'sent' });
      await metrics.idle();
      expect(onError).toHaveBeenCalledWith('metric_write_failed');
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      locker.release();
    }
    await metrics.idle();
    expect((await rows(schema)).map((r) => r.count)).toEqual([3]);
    // 같은 연결 풀의 다른 쿼리에는 timeout이 남지 않는다(SET LOCAL 범위 = 트랜잭션).
    const setting = await schema.pool.query<{ statement_timeout: string }>('SHOW statement_timeout');
    expect(setting.rows[0]?.statement_timeout).toBe('0');
  });

  it('연결 획득 대기 중 포기(abort)한 add는 나중에 연결을 얻어도 쓰지 않는다', async () => {
    schema = await migratedSchema();
    const store = createPgMetricsStore(schema.pool);
    const held = await Promise.all(Array.from({ length: 4 }, () => schema!.pool.connect()));
    const controller = new AbortController();
    let pending: Promise<unknown>;
    try {
      pending = store.add('2026-11-28', 'push_send_result', { outcome: 'sent' }, 1, controller.signal).catch((e: unknown) => e);
      controller.abort();
    } finally {
      for (const client of held) client.release();
    }
    expect(await pending).toBeInstanceOf(Error);
    expect(await rows(schema)).toEqual([]);
  });

  it('보관 삭제는 오늘 포함 7일 밖(cutoff 이전) 행만 지운다', async () => {
    schema = await migratedSchema();
    const store = createPgMetricsStore(schema.pool);
    for (const back of [0, 6, 7, 30]) {
      const metrics = createMetricsRecorder({ store, clock: () => T0 - back * DAY_MS });
      metrics.record({ event: 'push_send_result', outcome: 'sent' });
      await metrics.idle();
    }
    expect(await pruneMetrics(store, T0)).toBe(2);
    expect((await rows(schema)).map((r) => r.day)).toEqual(['2026-11-22', '2026-11-28']);
  });
});
