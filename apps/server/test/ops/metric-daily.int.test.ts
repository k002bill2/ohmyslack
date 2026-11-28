import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOG_CANARIES } from '../../../../tools/log-canaries.js';
import { METRIC_MAX_ABANDONED, METRIC_WRITE_TIMEOUT_MS, createMetricsRecorder, pruneMetrics } from '../../src/modules/ops/metrics.js';
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
const HUNG = Object.freeze({ code: 'test_bound_exceeded' });

/** 테스트측 상한(기록기 상한 METRIC_WRITE_TIMEOUT_MS보다 짧게): 넘기면 HUNG을 돌려준다. */
async function bounded<T>(work: Promise<T>, ms = METRIC_WRITE_TIMEOUT_MS / 2): Promise<T | typeof HUNG> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<typeof HUNG>((resolve) => {
    timer = setTimeout(() => resolve(HUNG), ms);
  });
  try {
    return await Promise.race([work, cap]);
  } finally {
    clearTimeout(timer);
  }
}
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
      // 테스트측 상한으로 감싸 statement_timeout이 없어도 매달리지 않고 단언으로 실패하게 한다(finally 정리 보장).
      const error = await bounded(store.add('2026-11-28', 'push_send_result', { outcome: 'sent' }, 1).catch((e: unknown) => e));
      expect((error as { code?: unknown } | typeof HUNG).code).toBe('57014');
      // 기록기 경로: 실패 → 재합산 + metric_write_failed.
      metrics.record({ event: 'push_send_result', outcome: 'sent' });
      metrics.record({ event: 'push_send_result', outcome: 'sent' });
      expect(await bounded(metrics.idle())).not.toBe(HUNG);
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

  it('포기·미정착 상한: 행 잠금으로 계측 쓰기가 멈춰도 계측이 쥔 연결(totalCount - idleCount - 잠금 1)은 METRIC_MAX_ABANDONED 이하, 해제 후 count 정확', async () => {
    schema = await migratedSchema();
    const pool = schema.pool;
    // 축척: flush 100ms·상한 50ms, statement_timeout은 길게(잠금 대기가 DB에서 끊기지 않아 포기된 호출이 연결을 계속 쥔다).
    const store = createPgMetricsStore(pool, { statementTimeoutMs: 60_000 });
    const onError = vi.fn();
    const metrics = createMetricsRecorder({ store, clock: () => T0, onError, flushIntervalMs: 100, writeTimeoutMs: 50 });
    metrics.record({ event: 'push_send_result', outcome: 'sent' });
    await metrics.idle();
    const locker = await pool.connect();
    let maxMetricHeld = 0;
    let recorded = 1;
    try {
      await locker.query('BEGIN');
      await locker.query("SELECT count FROM metric_daily WHERE event = 'push_send_result' FOR UPDATE");
      for (let cycle = 0; cycle < 12; cycle += 1) {
        metrics.record({ event: 'push_send_result', outcome: 'sent' });
        recorded += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        maxMetricHeld = Math.max(maxMetricHeld, pool.totalCount - pool.idleCount - 1);
      }
      expect(maxMetricHeld).toBeGreaterThan(0);
      expect(maxMetricHeld).toBeLessThanOrEqual(METRIC_MAX_ABANDONED);
      // 정지 중에도 주기마다 신호가 난다(관측 가능).
      expect(onError.mock.calls.length).toBeGreaterThanOrEqual(8);
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      locker.release();
    }
    // 해제 후: 포기된 호출은 커밋 전 signal 확인으로 ROLLBACK, 다음 flush가 재합산분을 한 번만 반영한다.
    for (let i = 0; i < 20 && pool.idleCount !== pool.totalCount; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    await metrics.close();
    expect((await rows(schema)).map((r) => r.count)).toEqual([recorded]);
    expect(pool.idleCount).toBe(pool.totalCount);
  });

  it('포기·미정착 상한: 풀 고갈 중 쌓이는 계측 connect 대기자는 METRIC_MAX_ABANDONED 이하이고, 해제 후 count 정확', async () => {
    schema = await migratedSchema();
    const pool = schema.pool;
    const store = createPgMetricsStore(pool);
    const metrics = createMetricsRecorder({ store, clock: () => T0, flushIntervalMs: 100, writeTimeoutMs: 50 });
    const held = await Promise.all(Array.from({ length: 4 }, () => pool.connect()));
    let maxWaiting = 0;
    try {
      metrics.record({ event: 'push_send_result', outcome: 'sent' });
      for (let cycle = 0; cycle < 12; cycle += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        maxWaiting = Math.max(maxWaiting, pool.waitingCount);
      }
    } finally {
      for (const client of held) client.release();
    }
    expect(maxWaiting).toBeGreaterThan(0);
    expect(maxWaiting).toBeLessThanOrEqual(METRIC_MAX_ABANDONED);
    for (let i = 0; i < 20 && (pool.waitingCount > 0 || pool.idleCount !== pool.totalCount); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    await metrics.close();
    expect((await rows(schema)).map((r) => r.count)).toEqual([1]);
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
