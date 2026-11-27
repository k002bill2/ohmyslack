import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOG_CANARIES } from '../../../../tools/log-canaries.js';
import {
  METRIC_CLOSE_TIMEOUT_MS,
  METRIC_FLUSH_INTERVAL_MS,
  METRIC_MAX_KEYS,
  createMetricsRecorder,
  metricDay,
  noopMetrics,
  pruneMetrics,
  retentionCutoff,
  startMetricRetention,
  type MetricDims,
  type MetricsStore,
} from '../../src/modules/ops/metrics.js';
import { METRIC_ALLOWLIST } from '../../src/shared.js';

/** FR-OPS-03·TR-SEC-09: 기록기는 허용 레코드만 버킷팅해 저장하고, 어떤 실패도 호출자에게 올리지 않는다. */
interface Row {
  readonly day: string;
  readonly event: string;
  readonly dims: MetricDims;
  readonly n: number;
}

function fakeStore(overrides: Partial<MetricsStore> = {}): MetricsStore & { readonly rows: Row[]; readonly cutoffs: string[] } {
  const rows: Row[] = [];
  const cutoffs: string[] = [];
  return {
    rows,
    cutoffs,
    async add(day, event, dims, n) {
      rows.push({ day, event, dims, n });
    },
    async pruneBefore(cutoff) {
      cutoffs.push(cutoff);
      return 0;
    },
    ...overrides,
  };
}

const T0 = Date.UTC(2026, 10, 28, 23, 59, 59);

afterEach(() => {
  vi.useRealTimers();
});

describe('metrics recorder', () => {
  it('허용 레코드는 duration_ms를 구간 하한으로 내려 (UTC 일자, event, dims)로 저장한다', async () => {
    const store = fakeStore();
    const metrics = createMetricsRecorder({ store, clock: () => T0 });
    metrics.record({ event: 'message_send_result', outcome: 'ok', conv_kind: 'dm', has_thread: true, duration_ms: 312.7 });
    metrics.record({ event: 'push_send_result', outcome: 'sent' });
    await metrics.idle();
    expect(store.rows).toEqual([
      { day: '2026-11-28', event: 'message_send_result', dims: { outcome: 'ok', conv_kind: 'dm', has_thread: true, duration_ms: 250 }, n: 1 },
      { day: '2026-11-28', event: 'push_send_result', dims: { outcome: 'sent' }, n: 1 },
    ]);
  });

  it('허용 밖 이벤트·키·값, 버킷팅할 수 없는 duration은 저장하지 않는다', async () => {
    const store = fakeStore();
    const metrics = createMetricsRecorder({ store, clock: () => T0 });
    metrics.record({ event: 'page_view', outcome: 'ok' });
    metrics.record({ event: 'push_send_result', outcome: 'sent', endpoint: 'https://push.example.test/x' });
    metrics.record({ event: 'auth_denied', action: 'login', reason: LOG_CANARIES.body ?? '', count: 1 });
    metrics.record({ event: 'message_send_result', outcome: 'ok', conv_kind: 'dm', has_thread: false, duration_ms: -5 });
    metrics.record({ event: 'message_send_result', outcome: 'ok', conv_kind: 'dm', has_thread: false, duration_ms: Number.NaN });
    metrics.record({ event: 'message_send_result', outcome: 'ok', conv_kind: 'dm', has_thread: false, duration_ms: '12' });
    await metrics.idle();
    expect(store.rows).toEqual([]);
  });

  it('입력 객체를 변경하지 않는다', async () => {
    const metrics = createMetricsRecorder({ store: fakeStore(), clock: () => T0 });
    const input = Object.freeze({ event: 'bot_delivery_result', direction: 'out', outcome: 'ok', has_attachment: false, duration_ms: 77 });
    metrics.record(input);
    await metrics.idle();
    expect(input.duration_ms).toBe(77);
  });

  it('저장소의 동기 예외·비동기 거부·시계 예외·onError 예외를 모두 삼킨다(unhandled rejection 없음)', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const onError = vi.fn(() => {
        throw new Error('logger down');
      });
      const syncThrow = createMetricsRecorder({
        store: fakeStore({
          add: () => {
            throw new Error('sync');
          },
        }),
        clock: () => T0,
        onError,
      });
      const asyncReject = createMetricsRecorder({ store: fakeStore({ add: () => Promise.reject(new Error('async')) }), clock: () => T0, onError });
      const badClock = createMetricsRecorder({
        store: fakeStore(),
        clock: () => {
          throw new Error('clock');
        },
        onError,
      });
      const input = { event: 'push_send_result', outcome: 'failed' };
      expect(() => syncThrow.record(input)).not.toThrow();
      expect(() => asyncReject.record(input)).not.toThrow();
      expect(() => badClock.record(input)).not.toThrow();
      await Promise.all([syncThrow.idle(), asyncReject.idle(), badClock.idle()]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(onError).toHaveBeenCalledTimes(3);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('noopMetrics는 아무것도 하지 않는다', () => {
    expect(() => noopMetrics.record({ event: 'push_send_result', outcome: 'sent' })).not.toThrow();
  });

  it('저장되는 dims 키는 그 이벤트의 allowlist 필드뿐이다', async () => {
    const store = fakeStore();
    const metrics = createMetricsRecorder({ store, clock: () => T0 });
    metrics.record({ event: 'auth_denied', action: 'api', reason: 'no_session', count: 1 });
    metrics.record({ event: 'bot_delivery_result', direction: 'out', outcome: 'duplicate', has_attachment: true, duration_ms: 3 });
    await metrics.idle();
    for (const row of store.rows) {
      const allowed = METRIC_ALLOWLIST[row.event as keyof typeof METRIC_ALLOWLIST];
      expect(Object.keys(row.dims).sort()).toEqual([...allowed].sort());
    }
  });
});

describe('metric retention (7일, 시간 주입)', () => {
  it('일자는 UTC, 보관 경계는 오늘 포함 7일(cutoff = 오늘 - 6일)', () => {
    expect(metricDay(T0)).toBe('2026-11-28');
    expect(metricDay(Date.UTC(2026, 10, 29, 0, 0, 0))).toBe('2026-11-29');
    expect(retentionCutoff(T0)).toBe('2026-11-22');
    expect(retentionCutoff(Date.UTC(2026, 2, 3, 12))).toBe('2026-02-25');
  });

  it('pruneMetrics는 주입 시각의 cutoff로 지운다', async () => {
    const store = fakeStore();
    await pruneMetrics(store, T0);
    expect(store.cutoffs).toEqual(['2026-11-22']);
  });

  it('startMetricRetention은 기동 시 1회 + 주기마다 실행하고, 실패는 onError로만 알린 뒤 정지 함수로 멈춘다', async () => {
    vi.useFakeTimers();
    let now = T0;
    const calls: string[] = [];
    const onError = vi.fn();
    const store = fakeStore({
      async pruneBefore(cutoff) {
        calls.push(cutoff);
        if (calls.length === 2) throw new Error('db down');
        return 1;
      },
    });
    const stop = startMetricRetention(store, () => now, onError, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['2026-11-22']);
    now += 24 * 60 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual(['2026-11-22', '2026-11-23']);
    expect(onError).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(2);
  });
});

describe('metrics 버퍼·주기 flush (SEC V1·QA P3-1)', () => {
  const PUSH = (outcome: string) => ({ event: 'push_send_result', outcome });
  const OUTCOMES = ['sent', 'expired', 'failed'] as const;

  it('끝나지 않는 저장소: record 10,000회와 주기 flush가 겹쳐도 진행 중 저장 호출은 1개를 넘지 않는다', async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const store = fakeStore({
      add: () => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<void>(() => undefined);
      },
    });
    const metrics = createMetricsRecorder({ store, clock: () => T0 });
    for (let i = 0; i < 10_000; i += 1) {
      metrics.record(PUSH(OUTCOMES[i % OUTCOMES.length] ?? 'sent'));
      if (i % 2500 === 0) await vi.advanceTimersByTimeAsync(METRIC_FLUSH_INTERVAL_MS);
    }
    void metrics.idle();
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_INTERVAL_MS * 3);
    expect(calls).toBe(1);
    expect(maxInFlight).toBe(1);
  });

  it('같은 dims 1,000회는 flush 1회·저장 호출 1회·증분 1,000으로 합산된다', async () => {
    const store = fakeStore();
    const metrics = createMetricsRecorder({ store, clock: () => T0 });
    for (let i = 0; i < 1000; i += 1) metrics.record(PUSH('sent'));
    await metrics.idle();
    expect(store.rows).toEqual([{ day: '2026-11-28', event: 'push_send_result', dims: { outcome: 'sent' }, n: 1000 }]);
  });

  it('주기 타이머가 idle 없이도 flush하고, 빈 버퍼면 저장소를 부르지 않는다', async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const metrics = createMetricsRecorder({ store, clock: () => T0 });
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_INTERVAL_MS);
    expect(store.rows).toEqual([]);
    metrics.record(PUSH('sent'));
    metrics.record(PUSH('sent'));
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_INTERVAL_MS);
    expect(store.rows).toEqual([{ day: '2026-11-28', event: 'push_send_result', dims: { outcome: 'sent' }, n: 2 }]);
    await metrics.close();
  });

  it('flush 실패한 증분은 버리지 않고 다음 flush에 새 증분과 합산된다(onError는 고정 코드)', async () => {
    const onError = vi.fn();
    let failNext = true;
    const store = fakeStore();
    const add = store.add.bind(store);
    const metrics = createMetricsRecorder({
      store: {
        ...store,
        add: (...args) => {
          if (failNext) {
            failNext = false;
            return Promise.reject(new Error('db down'));
          }
          return add(...args);
        },
      },
      clock: () => T0,
      onError,
    });
    for (let i = 0; i < 3; i += 1) metrics.record(PUSH('failed'));
    await metrics.idle();
    expect(onError).toHaveBeenCalledWith('metric_write_failed');
    expect(store.rows).toEqual([]);
    for (let i = 0; i < 2; i += 1) metrics.record(PUSH('failed'));
    await metrics.idle();
    expect(store.rows).toEqual([{ day: '2026-11-28', event: 'push_send_result', dims: { outcome: 'failed' }, n: 5 }]);
  });

  it('버퍼 키가 상한에 닿으면 새 키는 버리고 onError(metric_buffer_full)는 flush 주기당 1회, 기존 키 증분은 계속된다', async () => {
    const onError = vi.fn();
    const store = fakeStore();
    let now = T0;
    const metrics = createMetricsRecorder({ store, clock: () => now, onError, maxKeys: 2 });
    metrics.record(PUSH('sent'));
    metrics.record(PUSH('expired'));
    metrics.record(PUSH('failed'));
    now += 24 * 60 * 60 * 1000;
    metrics.record(PUSH('sent'));
    now = T0;
    metrics.record(PUSH('sent'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('metric_buffer_full');
    await metrics.idle();
    expect(store.rows).toEqual([
      { day: '2026-11-28', event: 'push_send_result', dims: { outcome: 'sent' }, n: 2 },
      { day: '2026-11-28', event: 'push_send_result', dims: { outcome: 'expired' }, n: 1 },
    ]);
    expect(METRIC_MAX_KEYS).toBeGreaterThan(2);
  });

  it('close: 주기 flush를 멈추고 남은 버퍼를 마지막으로 flush한다', async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const metrics = createMetricsRecorder({ store, clock: () => T0 });
    metrics.record(PUSH('sent'));
    await metrics.close();
    expect(store.rows).toHaveLength(1);
    metrics.record(PUSH('expired'));
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_INTERVAL_MS * 3);
    expect(store.rows).toHaveLength(1);
  });

  it('close: 저장소가 멈춰 있어도 METRIC_CLOSE_TIMEOUT_MS 뒤에 끝난다(종료가 매달리지 않음)', async () => {
    vi.useFakeTimers();
    const metrics = createMetricsRecorder({ store: fakeStore({ add: () => new Promise<void>(() => undefined) }), clock: () => T0 });
    metrics.record(PUSH('sent'));
    let done = false;
    void metrics.close().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(METRIC_CLOSE_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });
});
