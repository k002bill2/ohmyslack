/**
 * 클라이언트 계측 버퍼(PRD §10 2단계, `POST /api/metrics`): 합산·상한·주기/이탈 전송·실패 재합산·메모리 전용.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_METRIC_BODY_LIMIT_BYTES, CLIENT_METRIC_MAX_N, CLIENT_METRIC_MAX_RECORDS } from '../../../../packages/shared/src/metrics.js';
import { createMetricsBuffer, METRIC_FLUSH_MS, METRIC_HIDDEN_BATCHES, METRIC_MAX_KEYS, type MetricsLifecycle } from '../../src/data/metrics.js';

type Call = { readonly url: string; readonly init: RequestInit };

function harness(reply: () => Promise<Response> = () => Promise.resolve(new Response(JSON.stringify({ status: 'accepted' }), { status: 202 }))) {
  const calls: Call[] = [];
  let token: string | null = 'csrf-1';
  const respond = { next: reply };
  const buffer = createMetricsBuffer({
    fetch: (url, init) => {
      calls.push({ url, init: init ?? {} });
      return respond.next();
    },
    csrfToken: () => token,
  });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const win = new EventTarget();
  const lifecycle: MetricsLifecycle = { doc, win };
  const bodies = () => calls.map((c) => JSON.parse(String(c.init.body)) as { records: { event: string; dims: Record<string, unknown>; n: number }[] });
  return { buffer, calls, bodies, doc, win, lifecycle, respond, setToken: (t: string | null) => (token = t) };
}

const OK_SYNC = { trigger: 'connect', outcome: 'ok', caught_up_count: 2, duration_ms: 100 } as const;
/** 서로 다른 sync_result dims 조합(4×9×11 = 396개). */
const SYNC_COMBOS = ['connect', 'reconnect', 'foreground', 'manual'].flatMap((trigger) =>
  [0, 50, 100, 250, 500, 1000, 2500, 5000, 10000].flatMap((duration_ms) =>
    [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].map((caught_up_count) => ({ trigger, outcome: 'ok', caught_up_count, duration_ms })),
  ),
);
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('FR-OPS-03 계측 버퍼 기록(메모리 합산)', () => {
  it('같은 event+dims는 키 순서와 무관하게 한 레코드로 n을 더하고, 다른 dims는 따로 둔다', () => {
    const { buffer } = harness();
    buffer.record('sync_result', OK_SYNC);
    buffer.record('sync_result', { duration_ms: 100, caught_up_count: 2, outcome: 'ok', trigger: 'connect' });
    buffer.record('sync_result', { ...OK_SYNC, outcome: 'failed' });
    expect(buffer.pending()).toEqual([
      { event: 'sync_result', dims: OK_SYNC, n: 2 },
      { event: 'sync_result', dims: { ...OK_SYNC, outcome: 'failed' }, n: 1 },
    ]);
  });

  it('allowlist 밖(원시 ms·서버 전용 이벤트·여분 키·undefined 구간)은 버린다', () => {
    const { buffer } = harness();
    buffer.record('sync_result', { ...OK_SYNC, duration_ms: 137 });
    buffer.record('sync_result', { ...OK_SYNC, body: 'x' });
    buffer.record('read_sync_result', { outcome: 'ok', duration_ms: undefined });
    buffer.record('message_send_result' as never, { outcome: 'ok', conv_kind: 'dm', has_thread: false, duration_ms: 0 });
    expect(buffer.pending()).toEqual([]);
  });

  it('n은 CLIENT_METRIC_MAX_N(100)을 넘지 않는다', () => {
    const { buffer } = harness();
    for (let i = 0; i < CLIENT_METRIC_MAX_N + 20; i += 1) buffer.record('client_state', { state: 'online', count: 1 });
    expect(buffer.pending()).toEqual([{ event: 'client_state', dims: { state: 'online', count: 1 }, n: CLIENT_METRIC_MAX_N }]);
  });

  it('키 상한(METRIC_MAX_KEYS)을 넘는 새 키는 버리고 기존 키는 계속 합산한다', () => {
    const { buffer } = harness();
    const triggers = ['connect', 'reconnect', 'foreground', 'manual'];
    const durations = [0, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
    const counts = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    const combos = triggers.flatMap((trigger) => durations.flatMap((duration_ms) => counts.map((caught_up_count) => ({ trigger, outcome: 'ok', caught_up_count, duration_ms }))));
    for (const dims of combos.slice(0, METRIC_MAX_KEYS + 5)) buffer.record('sync_result', dims);
    buffer.record('sync_result', combos[0]!);
    const pending = buffer.pending();
    expect(pending).toHaveLength(METRIC_MAX_KEYS);
    expect(pending[0]?.n).toBe(2);
    expect(pending.some((p) => p.dims.caught_up_count === combos[METRIC_MAX_KEYS]!.caught_up_count && p.dims.duration_ms === combos[METRIC_MAX_KEYS]!.duration_ms && p.dims.trigger === combos[METRIC_MAX_KEYS]!.trigger)).toBe(false);
  });

  it('기록은 예외를 내지 않는다(던지는 getter가 있는 dims)', () => {
    const { buffer } = harness();
    const evil = Object.defineProperty({}, 'outcome', { enumerable: true, get: () => { throw new Error('boom'); } });
    expect(() => buffer.record('read_sync_result', evil)).not.toThrow();
    expect(buffer.pending()).toEqual([]);
  });
});

describe('FR-OPS-03 계측 전송(POST /api/metrics)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('60초 주기로 합산 n을 담아 POST 1회 — keepalive·same-origin·CSRF 헤더, 성공하면 비운다', async () => {
    const h = harness();
    const dispose = h.buffer.start(h.lifecycle);
    h.buffer.record('sync_result', OK_SYNC);
    h.buffer.record('sync_result', OK_SYNC);
    h.buffer.record('sync_result', OK_SYNC);
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_MS - 1);
    expect(h.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.url).toBe('/api/metrics');
    expect(call.init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'same-origin' });
    expect(call.init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-1' });
    expect(h.bodies()[0]).toEqual({ records: [{ event: 'sync_result', dims: OK_SYNC, n: 3 }] });
    expect(h.buffer.pending()).toEqual([]);
    // 빈 버퍼는 다음 주기에 보내지 않는다.
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_MS);
    expect(h.calls).toHaveLength(1);
    dispose();
  });

  it('첫 주기 전송 뒤에도 60초마다 계속 보낸다 — 2회차 데이터는 다음 주기에 다시 POST', async () => {
    const h = harness();
    const dispose = h.buffer.start(h.lifecycle);
    h.buffer.record('sync_result', OK_SYNC);
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_MS);
    expect(h.calls).toHaveLength(1);
    h.buffer.record('client_state', { state: 'offline', count: 1 });
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_MS - 1);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(2);
    expect(h.bodies()[1]).toEqual({ records: [{ event: 'client_state', dims: { state: 'offline', count: 1 }, n: 1 }] });
    expect(h.buffer.pending()).toEqual([]);
    dispose();
  });

  it('pagehide·visibilitychange(hidden)이면 바로 보낸다(keepalive), visible은 보내지 않는다', async () => {
    const h = harness();
    const dispose = h.buffer.start(h.lifecycle);
    h.buffer.record('client_state', { state: 'offline', count: 1 });
    h.doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(h.calls).toHaveLength(0);
    h.win.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.init).toMatchObject({ keepalive: true, credentials: 'same-origin' });
    h.buffer.record('client_state', { state: 'online', count: 1 });
    h.doc.visibilityState = 'hidden';
    h.doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(h.calls).toHaveLength(2);
    expect(h.bodies()[1]).toEqual({ records: [{ event: 'client_state', dims: { state: 'online', count: 1 }, n: 1 }] });
    dispose();
  });

  it('pagehide는 키 상한(64키)을 32개씩 2배치로 한꺼번에 keepalive 전송한다 — 각 본문 8KB 이하, 64키 모두 나간다', async () => {
    const h = harness();
    const dispose = h.buffer.start(h.lifecycle);
    const combos = SYNC_COMBOS.slice(0, METRIC_MAX_KEYS);
    for (const dims of combos) for (let i = 0; i < CLIENT_METRIC_MAX_N; i += 1) h.buffer.record('sync_result', dims);
    h.win.dispatchEvent(new Event('pagehide'));
    // 두 요청 모두 이벤트 처리 안에서 시작한다(앞 응답을 기다리지 않음 — 이탈 뒤에도 뒤 배치가 나가게).
    expect(h.calls).toHaveLength(METRIC_HIDDEN_BATCHES);
    await settle();
    expect(h.calls).toHaveLength(2);
    for (const call of h.calls) {
      expect(call.init).toMatchObject({ keepalive: true, credentials: 'same-origin' });
      expect(new TextEncoder().encode(String(call.init.body)).length).toBeLessThanOrEqual(CLIENT_METRIC_BODY_LIMIT_BYTES);
    }
    const sent = h.bodies().map((b) => b.records);
    expect(sent.map((records) => records.length)).toEqual([CLIENT_METRIC_MAX_RECORDS, CLIENT_METRIC_MAX_RECORDS]);
    expect(sent.flat().map((rec) => rec.dims)).toEqual(combos);
    expect(sent.flat().every((rec) => rec.n === CLIENT_METRIC_MAX_N)).toBe(true);
    expect(h.buffer.pending()).toEqual([]);
    dispose();
  });

  it('숨김 전송은 배치마다 결과를 따른다 — 5xx 배치만 다시 합치고 성공 배치는 비운다, 4xx 배치는 버린다', async () => {
    const h = harness();
    const dispose = h.buffer.start(h.lifecycle);
    const combos = SYNC_COMBOS.slice(0, METRIC_MAX_KEYS);
    for (const dims of combos) h.buffer.record('sync_result', dims);
    const statuses = [503, 202];
    h.respond.next = () => Promise.resolve(new Response(null, { status: statuses.shift() ?? 202 }));
    h.doc.visibilityState = 'hidden';
    h.doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(h.calls).toHaveLength(2);
    expect(h.buffer.pending().map((p) => p.dims)).toEqual(combos.slice(0, CLIENT_METRIC_MAX_RECORDS));
    const more = [202, 400];
    h.respond.next = () => Promise.resolve(new Response(null, { status: more.shift() ?? 202 }));
    for (const dims of combos.slice(CLIENT_METRIC_MAX_RECORDS)) h.buffer.record('sync_result', dims);
    h.win.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(h.calls).toHaveLength(4);
    expect(h.buffer.pending()).toEqual([]);
    dispose();
  });

  it('해제 뒤에는 주기·이탈 전송이 없다', async () => {
    const h = harness();
    h.buffer.start(h.lifecycle)();
    h.buffer.record('client_state', { state: 'offline', count: 1 });
    h.win.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_MS * 2);
    expect(h.calls).toHaveLength(0);
  });

  it('네트워크 실패·5xx면 다시 합쳐 다음 전송이 합산 n을 보낸다, 400은 버린다', async () => {
    const h = harness();
    h.buffer.record('read_sync_result', { outcome: 'ok', duration_ms: 50 });
    h.respond.next = () => Promise.reject(new TypeError('Failed to fetch'));
    await h.buffer.flush();
    h.buffer.record('read_sync_result', { outcome: 'ok', duration_ms: 50 });
    h.respond.next = () => Promise.resolve(new Response(null, { status: 503 }));
    await h.buffer.flush();
    h.buffer.record('read_sync_result', { outcome: 'ok', duration_ms: 50 });
    h.respond.next = () => Promise.resolve(new Response(null, { status: 202 }));
    await h.buffer.flush();
    expect(h.bodies().map((b) => b.records[0]?.n)).toEqual([1, 2, 3]);
    expect(h.buffer.pending()).toEqual([]);
    h.buffer.record('read_sync_result', { outcome: 'failed', duration_ms: 0 });
    h.respond.next = () => Promise.resolve(new Response(null, { status: 400 }));
    await h.buffer.flush();
    expect(h.buffer.pending()).toEqual([]);
  });

  it('401·403(세션 만료·CSRF 거부)은 다시 합치지 않고 버린다 — 만료 세션으로 매 주기 재전송하지 않게', async () => {
    const h = harness();
    for (const status of [401, 403]) {
      h.buffer.record('client_state', { state: 'offline', count: 1 });
      h.respond.next = () => Promise.resolve(new Response(null, { status }));
      await h.buffer.flush();
      expect(h.buffer.pending()).toEqual([]);
    }
  });

  it('재합산도 n 상한(100)을 지킨다', async () => {
    const h = harness(() => Promise.reject(new TypeError('Failed to fetch')));
    for (let i = 0; i < 80; i += 1) h.buffer.record('client_state', { state: 'online', count: 1 });
    const sending = h.buffer.flush();
    for (let i = 0; i < 80; i += 1) h.buffer.record('client_state', { state: 'online', count: 1 });
    await sending;
    expect(h.buffer.pending()).toEqual([{ event: 'client_state', dims: { state: 'online', count: 1 }, n: CLIENT_METRIC_MAX_N }]);
  });

  it('한 번에 CLIENT_METRIC_MAX_RECORDS(32)개까지만 보내고 나머지는 남긴다', async () => {
    const h = harness();
    const durations = [0, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
    const counts = [0, 1, 2, 5, 10];
    for (const duration_ms of durations) for (const caught_up_count of counts) h.buffer.record('sync_result', { trigger: 'manual', outcome: 'ok', caught_up_count, duration_ms });
    await h.buffer.flush();
    expect(h.bodies()[0]?.records).toHaveLength(CLIENT_METRIC_MAX_RECORDS);
    expect(h.buffer.pending()).toHaveLength(durations.length * counts.length - CLIENT_METRIC_MAX_RECORDS);
  });

  it('CSRF 토큰이 없으면(미인증) 보내지 않고 메모리에 둔다', async () => {
    const h = harness();
    h.setToken(null);
    h.buffer.record('client_state', { state: 'offline', count: 1 });
    await h.buffer.flush();
    expect(h.calls).toHaveLength(0);
    expect(h.buffer.pending()).toHaveLength(1);
  });

  it('fetch가 동기 예외를 던져도 flush는 실패하지 않고 다시 합친다', async () => {
    const h = harness(() => {
      throw new Error('sync boom');
    });
    h.buffer.record('client_state', { state: 'offline', count: 1 });
    await expect(h.buffer.flush()).resolves.toBeUndefined();
    expect(h.buffer.pending()).toHaveLength(1);
  });
});
