import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOG_CANARIES } from '../../../../tools/log-canaries.js';
import {
  METRIC_CLOSE_TIMEOUT_MS,
  METRIC_FLUSH_INTERVAL_MS,
  METRIC_MAX_ABANDONED,
  METRIC_MAX_KEYS,
  METRIC_STATEMENT_TIMEOUT_MS,
  METRIC_WRITE_TIMEOUT_MS,
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
  it('record(input, n)은 같은 키에 n만큼 합산하고, n이 1 이상 안전 정수가 아니면 버린다', async () => {
    const store = fakeStore();
    const metrics = createMetricsRecorder({ store, clock: () => T0 });
    const state = { event: 'client_state', state: 'offline', count: 1 } as const;
    metrics.record(state, 3);
    metrics.record(state, 4);
    metrics.record(state);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) metrics.record(state, bad);
    await metrics.idle();
    expect(store.rows).toEqual([{ day: '2026-11-28', event: 'client_state', dims: { state: 'offline', count: 1 }, n: 8 }]);
  });

  it('count·caught_up_count는 기록 전에 개수 구간 하한으로 내린다(R1)', async () => {
    const store = fakeStore();
    const metrics = createMetricsRecorder({ store, clock: () => T0 });
    metrics.record({ event: 'sync_result', trigger: 'connect', outcome: 'ok', caught_up_count: 37, duration_ms: 40 });
    metrics.record({ event: 'client_state', state: 'online', count: 5000 });
    metrics.record({ event: 'client_state', state: 'online', count: -1 });
    await metrics.idle();
    expect(store.rows).toEqual([
      { day: '2026-11-28', event: 'sync_result', dims: { trigger: 'connect', outcome: 'ok', caught_up_count: 20, duration_ms: 0 }, n: 1 },
      { day: '2026-11-28', event: 'client_state', dims: { state: 'online', count: 1000 }, n: 1 },
    ]);
  });

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

  it('startMetricRetention: 끝나지 않는 삭제는 상한 뒤 onError 1회·signal 중단, 다음 주기에 다시 실행된다', async () => {
    vi.useFakeTimers();
    const signals: (AbortSignal | undefined)[] = [];
    const onError = vi.fn();
    const store = fakeStore({
      pruneBefore: (_cutoff, signal) => {
        signals.push(signal);
        return new Promise<number>(() => undefined);
      },
    });
    const interval = METRIC_WRITE_TIMEOUT_MS * 4;
    const stop = startMetricRetention(store, () => T0, onError, interval);
    await vi.advanceTimersByTimeAsync(METRIC_WRITE_TIMEOUT_MS - 1);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(interval - METRIC_WRITE_TIMEOUT_MS);
    expect(signals).toHaveLength(2);
    stop();
  });
});

describe('metrics 버퍼·주기 flush (SEC V1·QA P3-1)', () => {
  const PUSH = (outcome: string) => ({ event: 'push_send_result', outcome });
  const OUTCOMES = ['sent', 'expired', 'failed'] as const;

  it('끝나지 않는 저장소: record 10,000회와 주기 flush가 겹쳐도 저장 호출은 flush 주기 수 이하이고, 새 호출 전에 앞 호출은 포기(abort)돼 있다', async () => {
    vi.useFakeTimers();
    // 쓰기 상한(METRIC_WRITE_TIMEOUT_MS) 도입 후: 끝나지 않는 호출은 상한에서 포기되고 다음 주기에 다시 시도된다.
    // V1 의도(요청당 쓰기 증폭 없음·기록기가 기다리는 호출 ≤ 1)는 "호출 수 ≤ 주기 수"와 "새 호출 시점에 앞 호출 전부 abort"로 본다.
    const signals: AbortSignal[] = [];
    let ownedAtStart = 0;
    let calls = 0;
    const store = fakeStore({
      add: (_day, _event, _dims, _n, signal) => {
        calls += 1;
        ownedAtStart = Math.max(ownedAtStart, signals.filter((s) => !s.aborted).length + 1);
        if (signal !== undefined) signals.push(signal);
        return new Promise<void>(() => undefined);
      },
    });
    const metrics = createMetricsRecorder({ store, clock: () => T0 });
    for (let i = 0; i < 10_000; i += 1) {
      metrics.record(PUSH(OUTCOMES[i % OUTCOMES.length] ?? 'sent'));
      // 첫 주기 flush 시점에 버퍼 키가 3개(sent·expired·failed)여야 행 순차 drain을 판별한다.
      if (i % 2500 === 2499) await vi.advanceTimersByTimeAsync(METRIC_FLUSH_INTERVAL_MS);
    }
    void metrics.idle();
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_INTERVAL_MS * 3);
    // 경과 70초 = 주기 7회(+ idle 1회). 상한 포기 시 남은 행은 부르지 않으므로 주기당 호출 ≤ 1.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(8);
    expect(signals).toHaveLength(calls);
    expect(ownedAtStart).toBe(1);
  });

  it('끝나지 않는 저장소: 상한 뒤 inFlight가 풀리고 metric_write_failed 1회, 다음 flush에 다시 호출되며 회복 후 증분이 유실·중복 없이 반영된다', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const calls: { readonly dims: MetricDims; readonly n: number; readonly signal: AbortSignal | undefined }[] = [];
    let hang = true;
    const hung: ((error: Error) => void)[] = [];
    const store = fakeStore();
    const add = store.add.bind(store);
    const metrics = createMetricsRecorder({
      store: {
        ...store,
        add: (day, event, dims, n, signal) => {
          calls.push({ dims, n, signal });
          return hang
            ? new Promise<void>((_, reject) => {
                hung.push(reject);
              })
            : add(day, event, dims, n);
        },
      },
      clock: () => T0,
      onError,
    });
    for (let i = 0; i < 3; i += 1) metrics.record(PUSH('sent'));
    metrics.record(PUSH('expired'));
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_INTERVAL_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(METRIC_WRITE_TIMEOUT_MS - 1);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // 상한 도달: 첫 호출 포기, 남은 행(expired)은 부르지 않고 재합산, 신호 1회.
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('metric_write_failed');
    // inFlight 해제 확인: 다음 주기에 저장소가 다시 불린다(여전히 멈춤).
    metrics.record(PUSH('sent'));
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_INTERVAL_MS - METRIC_WRITE_TIMEOUT_MS);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.n).toBe(4);
    await vi.advanceTimersByTimeAsync(METRIC_WRITE_TIMEOUT_MS);
    expect(onError).toHaveBeenCalledTimes(2);
    // 회복: 포기된 호출도 (중단 오류로) 정착하고, 쌓인 증분이 한 번씩만 반영된다.
    hang = false;
    for (const reject of hung) reject(new Error('aborted'));
    metrics.record(PUSH('expired'));
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_INTERVAL_MS - METRIC_WRITE_TIMEOUT_MS);
    expect(store.rows).toEqual([
      { day: '2026-11-28', event: 'push_send_result', dims: { outcome: 'sent' }, n: 4 },
      { day: '2026-11-28', event: 'push_send_result', dims: { outcome: 'expired' }, n: 2 },
    ]);
    expect(onError).toHaveBeenCalledTimes(2);
    await metrics.close();
  });

  it('상한 순서: 종료 상한 < 쓰기 상한 < flush 주기, statement_timeout < 쓰기 상한', () => {
    expect(METRIC_CLOSE_TIMEOUT_MS).toBeLessThan(METRIC_WRITE_TIMEOUT_MS);
    expect(METRIC_WRITE_TIMEOUT_MS).toBeLessThan(METRIC_FLUSH_INTERVAL_MS);
    expect(METRIC_STATEMENT_TIMEOUT_MS).toBeLessThan(METRIC_WRITE_TIMEOUT_MS);
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

describe('metrics 겹침·포기 상한 (QA P1-1·P3-2)', () => {
  const PUSH = (outcome: string) => ({ event: 'push_send_result', outcome });
  const ROW_MS = 4000;

  it('상한 안에서 느린 저장소(행마다 4초·3행 → drain 12초 > 주기 10초)여도 진행 중 저장 호출은 1개뿐이다', async () => {
    vi.useFakeTimers();
    expect(ROW_MS).toBeLessThan(METRIC_WRITE_TIMEOUT_MS);
    expect(ROW_MS * 3).toBeGreaterThan(METRIC_FLUSH_INTERVAL_MS);
    let active = 0;
    let maxInFlight = 0;
    const store = fakeStore();
    const add = store.add.bind(store);
    const metrics = createMetricsRecorder({
      store: {
        ...store,
        add: async (day, event, dims, n) => {
          active += 1;
          maxInFlight = Math.max(maxInFlight, active);
          await new Promise((resolve) => setTimeout(resolve, ROW_MS));
          active -= 1;
          await add(day, event, dims, n);
        },
      },
      clock: () => T0,
    });
    for (const outcome of ['sent', 'expired', 'failed']) metrics.record(PUSH(outcome));
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_INTERVAL_MS + 1);
    // 첫 drain이 진행 중일 때 새 증분이 들어와야 다음 tick에 가드가 없으면 두 번째 drain이 겹친다.
    for (const outcome of ['sent', 'expired', 'failed']) metrics.record(PUSH(outcome));
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_INTERVAL_MS * 4);
    expect(maxInFlight).toBe(1);
    const totals = new Map<string, number>();
    for (const row of store.rows) totals.set(String(row.dims.outcome), (totals.get(String(row.dims.outcome)) ?? 0) + row.n);
    expect(Object.fromEntries(totals)).toEqual({ sent: 2, expired: 2, failed: 2 });
    await metrics.close();
  });

  it('포기됐지만 정착하지 않은 호출이 METRIC_MAX_ABANDONED개면 저장소를 부르지 않고 주기마다 metric_write_failed, 하나가 정착하면 재개해 증분을 정확히 반영한다', async () => {
    vi.useFakeTimers();
    expect(METRIC_MAX_ABANDONED).toBe(2);
    const onError = vi.fn();
    const settle: ((error: Error) => void)[] = [];
    let hang = true;
    const store = fakeStore();
    const add = store.add.bind(store);
    let calls = 0;
    const metrics = createMetricsRecorder({
      store: {
        ...store,
        add: (day, event, dims, n) => {
          calls += 1;
          if (!hang) return add(day, event, dims, n);
          return new Promise<void>((_, reject) => {
            settle.push(reject);
          });
        },
      },
      clock: () => T0,
      onError,
    });
    metrics.record(PUSH('sent'));
    // 주기 1·2: 각 1회 호출 → 상한에서 포기(미정착 1 → 2).
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_INTERVAL_MS * 2 + METRIC_WRITE_TIMEOUT_MS);
    expect(calls).toBe(2);
    expect(onError).toHaveBeenCalledTimes(2);
    // 주기 3·4: 미정착이 상한(2)이라 저장소를 부르지 않는다. 정지 중에도 주기마다 신호는 난다(관측 가능).
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_INTERVAL_MS * 2);
    expect(calls).toBe(2);
    expect(onError).toHaveBeenCalledTimes(4);
    expect(onError).toHaveBeenLastCalledWith('metric_write_failed');
    // 포기된 호출 하나가 (중단 오류로) 정착 → 미정착 1 &lt; 상한 → 다음 주기 재개.
    hang = false;
    settle[0]?.(new Error('aborted'));
    metrics.record(PUSH('expired'));
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_INTERVAL_MS);
    expect(calls).toBe(4);
    expect(store.rows).toEqual([
      { day: '2026-11-28', event: 'push_send_result', dims: { outcome: 'sent' }, n: 1 },
      { day: '2026-11-28', event: 'push_send_result', dims: { outcome: 'expired' }, n: 1 },
    ]);
    expect(onError).toHaveBeenCalledTimes(4);
    await metrics.close();
  });

  it('retention도 같은 저장소의 포기·미정착 상한을 공유한다: 기록기가 상한을 채우면 삭제를 건너뛰고 onError만 낸다', async () => {
    vi.useFakeTimers();
    const prunes: string[] = [];
    const store = fakeStore({
      add: () => new Promise<void>(() => undefined),
      async pruneBefore(cutoff) {
        prunes.push(cutoff);
        return 0;
      },
    });
    const metrics = createMetricsRecorder({ store, clock: () => T0 });
    metrics.record(PUSH('sent'));
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_INTERVAL_MS * METRIC_MAX_ABANDONED + METRIC_WRITE_TIMEOUT_MS);
    const onError = vi.fn();
    const stop = startMetricRetention(store, () => T0, onError);
    await vi.advanceTimersByTimeAsync(0);
    expect(prunes).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    stop();
    await metrics.close();
  });
});
