import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthEvents } from '../../src/modules/auth/events.js';
import type { AuthService, Authenticated } from '../../src/modules/auth/service.js';
import { createConversationEvents } from '../../src/modules/conversations/events.js';
import type { ConversationsService } from '../../src/modules/conversations/service.js';
import { createMessageEvents } from '../../src/modules/messages/events.js';
import { createHub, SESSION_SWEEP_MS, type Hub, type HubSocket } from '../../src/modules/realtime/hub.js';
import { createReadEvents } from '../../src/modules/sync/events.js';
import type { SyncStore } from '../../src/modules/sync/store.js';

/** F-2·NC-21 세션 sweep: 일괄 조회 1회/주기, 무효 세션 1008, 연결 0이면 타이머 정지, dispose 시 타이머 누수 0. */
const T0 = Date.parse('2026-11-07T00:00:00Z');
const FAR = new Date(T0 + 3_600_000);

interface FakeSocket extends HubSocket {
  readonly closes: { code: number | undefined; reason: string | undefined }[];
}

function fakeSocket(): FakeSocket {
  const closes: FakeSocket['closes'] = [];
  return { closes, send: () => undefined, close: (code, reason) => closes.push({ code, reason }) };
}

interface SweepState {
  readonly live: Set<string>;
  readonly batches: string[][];
  failure: Error | undefined;
  /** 주어지면 일괄 조회가 이 promise를 기다린다(조회 도중 경쟁 재현). */
  gate: Promise<void> | undefined;
}

let hub: Hub | undefined;

afterEach(() => {
  hub?.dispose();
  hub = undefined;
  vi.useRealTimers();
});

function setup(withBatch = true): { hub: Hub; st: SweepState } {
  const st: SweepState = { live: new Set(), batches: [], failure: undefined, gate: undefined };
  const peek = async (token: string | undefined): Promise<Authenticated | undefined> =>
    token !== undefined && st.live.has(token) ? ({ token, session: { id: token } } as unknown as Authenticated) : undefined;
  const liveSessionIds = async (ids: readonly string[]): Promise<ReadonlySet<string>> => {
    st.batches.push([...ids]);
    if (st.gate !== undefined) await st.gate;
    if (st.failure !== undefined) throw st.failure;
    return new Set(ids.filter((id) => st.live.has(id)));
  };
  const auth = (withBatch ? { peek, liveSessionIds } : { peek }) as unknown as AuthService;
  hub = createHub({
    auth,
    conversations: {} as unknown as ConversationsService,
    syncStore: {} as unknown as SyncStore,
    authEvents: createAuthEvents(),
    conversationEvents: createConversationEvents(),
    messageEvents: createMessageEvents(),
    readEvents: createReadEvents(),
    clock: () => Date.now(),
  });
  return { hub, st };
}

/** sessionId = token = id로 붙인다. */
function attach(h: Hub, st: SweepState, id: string, userId = 'u1') {
  st.live.add(id);
  const socket = fakeSocket();
  const conn = h.attach(socket, { userId, sessionId: id, token: id, expiresAt: FAR });
  return { socket, conn };
}

describe('세션 sweep (F-2)', () => {
  it('주기는 5초 보장을 위해 4초 이하다', () => {
    expect(SESSION_SWEEP_MS).toBeLessThanOrEqual(4000);
  });

  it('주기마다 열린 연결의 세션을 한 번에 조회하고 무효 세션만 1008 session_ended로 닫는다', async () => {
    vi.useFakeTimers({ now: T0 });
    const { hub: h, st } = setup();
    const a = attach(h, st, 's-a');
    const b = attach(h, st, 's-b', 'u2');
    const a2 = attach(h, st, 's-a2');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(4); // 만료 3 + sweep 1
    st.live.delete('s-a');
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_MS);
    expect(st.batches).toEqual([['s-a', 's-b', 's-a2']]);
    expect(a.socket.closes).toEqual([{ code: 1008, reason: 'session_ended' }]);
    expect(b.socket.closes).toEqual([]);
    expect(a2.socket.closes).toEqual([]);
    expect(h.size()).toBe(2);
    expect(vi.getTimerCount()).toBe(3); // 만료 2 + 다음 sweep 1
  });

  it('조회가 실패하면 아무것도 닫지 않고 다음 주기에 다시 확인한다', async () => {
    vi.useFakeTimers({ now: T0 });
    const { hub: h, st } = setup();
    const a = attach(h, st, 's-a');
    await vi.advanceTimersByTimeAsync(0); // attach 직후 peek 재확인을 먼저 끝낸다
    st.failure = new Error('db down');
    st.live.delete('s-a');
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_MS);
    expect(a.socket.closes).toEqual([]);
    expect(h.size()).toBe(1);
    st.failure = undefined;
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_MS);
    expect(st.batches).toHaveLength(2);
    expect(a.socket.closes).toEqual([{ code: 1008, reason: 'session_ended' }]);
  });

  it('마지막 연결이 detach·close되면 sweep 타이머가 멈추고 다시 붙으면 재개한다', async () => {
    vi.useFakeTimers({ now: T0 });
    const { hub: h, st } = setup();
    const a = attach(h, st, 's-a');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(2);
    h.detach(a.conn);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_MS * 3);
    expect(st.batches).toEqual([]);

    const b = attach(h, st, 's-b');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(2);
    st.live.delete('s-b');
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_MS);
    expect(b.socket.closes).toEqual([{ code: 1008, reason: 'session_ended' }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('조회 도중 연결이 0이 됐다가 다시 붙어도 sweep 타이머는 하나뿐이다', async () => {
    vi.useFakeTimers({ now: T0 });
    const { hub: h, st } = setup();
    let release: () => void = () => undefined;
    st.gate = new Promise<void>((r) => {
      release = r;
    });
    const a = attach(h, st, 's-a');
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_MS); // 첫 조회가 gate에 걸린 채 진행 중
    expect(st.batches).toHaveLength(1);
    h.detach(a.conn);
    attach(h, st, 's-b');
    expect(vi.getTimerCount()).toBe(1); // 만료 1, 조회 중이라 새 sweep 예약 없음
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(2); // 만료 1 + sweep 1
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_MS);
    expect(st.batches).toEqual([['s-a'], ['s-b']]);
  });

  it('dispose하면 타이머가 하나도 남지 않는다', async () => {
    vi.useFakeTimers({ now: T0 });
    const { hub: h, st } = setup();
    attach(h, st, 's-a');
    attach(h, st, 's-b');
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_MS);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    h.dispose();
    hub = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('일괄 조회가 없는 AuthService면 sweep을 켜지 않는다(만료 타이머만)', async () => {
    vi.useFakeTimers({ now: T0 });
    const { hub: h, st } = setup(false);
    attach(h, st, 's-a');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
  });
});
