/**
 * 계측 관찰 지점(PRD §10 2단계): sync_result·read_sync_result·client_state를 HttpDataSource가 올바른 dims로 기록하는지,
 * 기록기가 실패해도 sync 결과가 바뀌지 않는지, 계측이 브라우저 지속 저장소를 쓰지 않는지.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_TIMEOUT_MS } from '../../src/data/api.js';
import { writeCheckpoint } from '../../src/features/sync';
import type { MetricDims, MetricsRecorder } from '../../src/data/metrics.js';
import { CONV, ME, flush, message, setup, summary } from '../sync/fake-server.js';

type Rec = { readonly event: string; readonly dims: MetricDims };

function recorder() {
  const records: Rec[] = [];
  const metrics: MetricsRecorder = { record: (event, dims) => records.push({ event, dims }) };
  const of = (event: string) => records.filter((r) => r.event === event).map((r) => r.dims);
  return { metrics, records, of };
}

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await flush();
};

const syncPage = (n: number) => ({
  status: 200,
  body: {
    changes: Array.from({ length: n }, (_, i) => ({ change_id: i + 1, message: message(i + 1) })),
    through_cursor: n,
    scanned_through: n,
    has_more: false,
    next_cursor: n,
  },
});

const lifecycle = () => ({ doc: Object.assign(new EventTarget(), { visibilityState: 'visible' }), win: new EventTarget() });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FR-OPS-03 sync_result 관찰 지점', () => {
  it('첫 연결 catch-up 성공: trigger connect·outcome ok·caught_up_count는 적용한 변경 수의 구간값', async () => {
    const r = recorder();
    const { server, ds, storage } = setup({ metrics: r.metrics, now: () => 0 });
    writeCheckpoint(ME, 0, storage);
    server.on('GET /api/sync', () => syncPage(3));
    expect(await ds.resume()).toBe(true);
    expect(r.of('sync_result')).toEqual([{ trigger: 'connect', outcome: 'ok', caught_up_count: 2, duration_ms: 0 }]);
  });

  it('소요 시간은 구간 하한으로 기록한다(주입 시계)', async () => {
    const r = recorder();
    let t = 0;
    const { server, ds, storage } = setup({ metrics: r.metrics, now: () => t });
    writeCheckpoint(ME, 0, storage);
    server.on('GET /api/sync', () => {
      t = 730;
      return syncPage(0);
    });
    await ds.resume();
    expect(r.of('sync_result')).toEqual([{ trigger: 'connect', outcome: 'ok', caught_up_count: 0, duration_ms: 500 }]);
  });

  it('sync 성공은 뒤 단계(목록 로드·소켓 열림 대기)를 기다리지 않고 그 자리에서 1건 기록한다', async () => {
    const r = recorder();
    const { server, ds, storage } = setup({ metrics: r.metrics, now: () => 0 });
    writeCheckpoint(ME, 0, storage);
    server.on('GET /api/sync', () => syncPage(1));
    const seenAtList: number[] = [];
    server.on('GET /api/conversations', () => {
      seenAtList.push(r.of('sync_result').length);
      return { status: 200, body: { conversations: [summary()], next_cursor: null } };
    });
    expect(await ds.resume()).toBe(true);
    expect(seenAtList).toEqual([1]);
    expect(r.of('sync_result')).toEqual([{ trigger: 'connect', outcome: 'ok', caught_up_count: 1, duration_ms: 0 }]);
  });

  it('sync 성공 뒤 목록 로드가 서버 불가로 재시도돼도 sync_result는 절차당 1건', async () => {
    const r = recorder();
    const { server, ds, storage } = setup({ metrics: r.metrics, now: () => 0 });
    writeCheckpoint(ME, 0, storage);
    server.on('GET /api/sync', () => syncPage(0));
    let lists = 0;
    server.on('GET /api/conversations', () => {
      lists += 1;
      return lists === 1 ? { status: 502, body: {} } : { status: 200, body: { conversations: [summary()], next_cursor: null } };
    });
    await ds.resume();
    await settle();
    expect(lists).toBe(2);
    expect(r.of('sync_result')).toEqual([{ trigger: 'connect', outcome: 'ok', caught_up_count: 0, duration_ms: 0 }]);
  });

  it('410 → snapshot 재초기화: outcome resync_required', async () => {
    const r = recorder();
    const { server, ds, storage } = setup({ metrics: r.metrics, now: () => 0 });
    writeCheckpoint(ME, 7, storage);
    server.on('GET /api/sync', (url) => (url.searchParams.get('after') === '7' ? { status: 410, body: { error: { code: 'cursor_expired' } } } : syncPage(0)));
    expect(await ds.resume()).toBe(true);
    expect(r.of('sync_result')).toEqual([{ trigger: 'connect', outcome: 'resync_required', caught_up_count: 0, duration_ms: 0 }]);
  });

  it('410 뒤 재초기화도 실패하면 outcome failed와 client_state resync_error', async () => {
    const r = recorder();
    const { server, ds, storage } = setup({ metrics: r.metrics, now: () => 0 });
    writeCheckpoint(ME, 7, storage);
    server.on('GET /api/sync', () => ({ status: 410, body: { error: { code: 'cursor_expired' } } }));
    expect(await ds.resume()).toBe(false);
    expect(r.of('sync_result')).toEqual([{ trigger: 'connect', outcome: 'failed', caught_up_count: 0, duration_ms: 0 }]);
    expect(r.of('client_state')).toContainEqual({ state: 'resync_error', count: 1 });
  });

  it('sync 실패(5xx): outcome failed', async () => {
    const r = recorder();
    const { server, ds, storage } = setup({ metrics: r.metrics, now: () => 0 });
    writeCheckpoint(ME, 0, storage);
    server.on('GET /api/sync', () => ({ status: 500, body: { error: { code: 'internal' } } }));
    expect(await ds.resume()).toBe(false);
    expect(r.of('sync_result')).toEqual([{ trigger: 'connect', outcome: 'failed', caught_up_count: 0, duration_ms: 0 }]);
  });

  it('서버 불가 1회 뒤 재시도 성공: resume 1번에 sync_result 1건(ok), 소요 시간은 첫 시도부터 잰다', async () => {
    const r = recorder();
    let t = 0;
    let calls = 0;
    const { server, ds, storage } = setup({ metrics: r.metrics, now: () => t });
    writeCheckpoint(ME, 0, storage);
    server.on('GET /api/sync', () => {
      calls += 1;
      t = calls * 300;
      return calls === 1 ? 'network' : syncPage(0);
    });
    expect(await ds.resume()).toBe(true);
    expect(calls).toBe(2);
    // 시도별로 재면 250(300ms 구간), 첫 시도부터 재면 600ms → 500 구간.
    expect(r.of('sync_result')).toEqual([{ trigger: 'connect', outcome: 'ok', caught_up_count: 0, duration_ms: 500 }]);
  });

  it('서버 불가가 재시도까지 이어지면: resume 1번에 sync_result 1건(failed)', async () => {
    const r = recorder();
    const { server, ds, storage } = setup({ metrics: r.metrics, now: () => 0 });
    writeCheckpoint(ME, 0, storage);
    let calls = 0;
    server.on('GET /api/sync', () => {
      calls += 1;
      return 'network';
    });
    expect(await ds.resume()).toBe(false);
    expect(calls).toBe(2);
    expect(r.of('sync_result')).toEqual([{ trigger: 'connect', outcome: 'failed', caught_up_count: 0, duration_ms: 0 }]);
  });

  it('첫 시도 sync 실패 뒤 재시도가 /api/me에서 실패해도 첫 시도 결과 1건(failed)을 남긴다', async () => {
    const r = recorder();
    const { server, ds, storage } = setup({ metrics: r.metrics, now: () => 0 });
    writeCheckpoint(ME, 0, storage);
    server.on('GET /api/sync', () => {
      server.on('GET /api/me', () => 'network');
      return 'network';
    });
    expect(await ds.resume()).toBe(false);
    expect(r.of('sync_result')).toEqual([{ trigger: 'connect', outcome: 'failed', caught_up_count: 0, duration_ms: 0 }]);
  });

  it('요청 시간 상한 초과: outcome timeout(재시도까지 응답 없음 → 1건)', async () => {
    vi.useFakeTimers();
    try {
      const r = recorder();
      let syncCalls = 0;
      // /api/sync만 응답하지 않는다 — 시간 상한이 끊으면(abort) 브라우저처럼 DOMException 'TimeoutError'로 거부한다.
      const hang = (init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          syncCalls += 1;
          init?.signal?.addEventListener('abort', () => reject(new DOMException('signal timed out', 'TimeoutError')));
        });
      const holder: { fetch?: (u: string, i?: RequestInit) => Promise<Response> } = {};
      const ctx = setup({
        metrics: r.metrics,
        now: () => 0,
        fetch: (u, i) => (new URL(u, 'https://oms.test').pathname === '/api/sync' ? hang(i) : holder.fetch!(u, i)),
      });
      holder.fetch = ctx.server.fetch;
      writeCheckpoint(ME, 0, ctx.storage);
      const result = ctx.ds.resume();
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      expect(await result).toBe(false);
      expect(syncCalls).toBe(2);
      expect(r.of('sync_result')).toEqual([{ trigger: 'connect', outcome: 'timeout', caught_up_count: 0, duration_ms: 0 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('복귀 계기: 전경 복귀 foreground, 「다시 시도」 manual, 1008 재연결 reconnect', async () => {
    const r = recorder();
    const life = lifecycle();
    const { server, ds, storage } = setup({ metrics: r.metrics, now: () => 0, lifecycle: life });
    writeCheckpoint(ME, 0, storage);
    expect(await ds.start()).toBe(true);
    life.doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    ds.reload?.();
    await settle();
    server.socket.serverClose(1008);
    await settle();
    expect(r.of('sync_result').map((d) => d.trigger)).toEqual(['connect', 'foreground', 'manual', 'reconnect']);
    expect(r.of('sync_result').every((d) => d.outcome === 'ok')).toBe(true);
  });
});

describe('FR-OPS-03 read_sync_result 관찰 지점', () => {
  function readWorld(reply: () => unknown) {
    const r = recorder();
    const life = lifecycle();
    const ctx = setup({ metrics: r.metrics, now: () => 0, lifecycle: life });
    ctx.server.on('GET /api/conversations', () => ({ status: 200, body: { conversations: [summary({ last_seq: 5, unread_count: 3 })], next_cursor: null } }));
    ctx.server.on('PUT /api/read-state', reply as never);
    writeCheckpoint(ME, 0, ctx.storage);
    return { ...ctx, r, life };
  }
  const ok = (seq: number) => () => ({ status: 200, body: { conversation_id: CONV, thread_root_id: null, last_read_seq: seq, updated_at: '2026-11-08T00:00:00Z' } });

  async function markAndFlush(w: ReturnType<typeof readWorld>) {
    w.ds.open?.(CONV);
    expect(await w.ds.start()).toBe(true);
    w.ds.markRead?.(CONV, null, 5);
    // 전경 이탈은 대기 중 읽음 위치를 즉시 보낸다.
    w.life.doc.visibilityState = 'hidden';
    w.life.doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
  }

  it('저장 성공: outcome ok', async () => {
    const w = readWorld(ok(5));
    await markAndFlush(w);
    expect(w.r.of('read_sync_result')).toEqual([{ outcome: 'ok', duration_ms: 0 }]);
  });

  it('서버가 보낸 값보다 낮은 위치를 돌려주면 mismatch', async () => {
    const w = readWorld(ok(4));
    await markAndFlush(w);
    expect(w.r.of('read_sync_result')).toEqual([{ outcome: 'mismatch', duration_ms: 0 }]);
  });

  it('저장 실패(5xx·네트워크): outcome failed', async () => {
    const w = readWorld(() => ({ status: 500, body: { error: { code: 'internal' } } }));
    await markAndFlush(w);
    expect(w.r.of('read_sync_result')).toEqual([{ outcome: 'failed', duration_ms: 0 }]);
  });
});

describe('FR-OPS-03 client_state 관찰 지점', () => {
  it('전이마다 1회: online → reconnecting → offline → online(catching-up은 기록하지 않음)', async () => {
    const r = recorder();
    const life = lifecycle();
    const timers: (() => void)[] = [];
    const { server, ds, storage } = setup({ metrics: r.metrics, now: () => 0, lifecycle: life, setTimer: (fn) => timers.push(fn) });
    writeCheckpoint(ME, 0, storage);
    ds.open?.(CONV);
    expect(await ds.start()).toBe(true);
    server.socket.serverClose(1006);
    await settle();
    life.win.dispatchEvent(new Event('offline'));
    life.win.dispatchEvent(new Event('offline'));
    await settle();
    life.win.dispatchEvent(new Event('online'));
    // 재연결 백오프 타이머 → 새 소켓 열림 → 복귀 절차가 구독까지 끝낸다.
    timers.splice(0).forEach((fn) => fn());
    await settle();
    expect(ds.getSnapshot().connection).toBe('connected');
    expect(r.of('client_state').map((d) => d.state)).toEqual(['online', 'reconnecting', 'offline', 'online']);
    expect(r.of('client_state').every((d) => d.count === 1)).toBe(true);
  });
});

describe('FR-OPS-03 계측 격리', () => {
  it('기록기가 예외를 던져도 sync 결과·데이터 적용·연결 상태는 그대로다', async () => {
    const record = vi.fn(() => {
      throw new Error('recorder broken');
    });
    const { server, ds, storage } = setup({ metrics: { record } });
    writeCheckpoint(ME, 0, storage);
    server.on('GET /api/sync', () => syncPage(2));
    ds.open?.(CONV);
    expect(await ds.resume()).toBe(true);
    expect(record).toHaveBeenCalled();
    expect(ds.getSnapshot().connection).toBe('connected');
    expect(ds.getSnapshot().messages.map((m) => m.body)).toEqual(['m1', 'm2']);
  });

  it('기본 버퍼: 숨김 전환 때 POST /api/metrics로 보내고 localStorage·sessionStorage·IndexedDB는 쓰지 않는다', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const idbOpen = vi.fn();
    if (typeof indexedDB === 'undefined') vi.stubGlobal('indexedDB', { open: idbOpen });
    else vi.spyOn(indexedDB, 'open').mockImplementation(idbOpen);
    const life = lifecycle();
    const { server, ds, storage } = setup({ lifecycle: life });
    const posts: unknown[] = [];
    server.on('POST /api/metrics', (_url, init) => {
      posts.push({ body: JSON.parse(String(init?.body)), keepalive: init?.keepalive, credentials: init?.credentials });
      return { status: 202, body: { status: 'accepted' } };
    });
    writeCheckpoint(ME, 0, storage);
    expect(await ds.start()).toBe(true);
    life.doc.visibilityState = 'hidden';
    life.doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ keepalive: true, credentials: 'same-origin' });
    const records = (posts[0] as { body: { records: { event: string }[] } }).body.records.map((x) => x.event).sort();
    expect(records).toEqual(['client_state', 'sync_result']);
    expect(setItem).not.toHaveBeenCalled();
    expect(idbOpen).not.toHaveBeenCalled();
    ds.stop();
  });
});
