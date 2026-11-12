/** PR 28 Codex r4 P2×2: 목록 조회 응답 순서 — 오래된 응답 무시, pending 해제는 동작 성공 시점 이후 시작된 조회 기준. */
import { describe, expect, it } from 'vitest';
import { writeCheckpoint } from '../../src/features/sync';
import { CONV, ME, flush, setup, summary, U, type FakeServer } from './fake-server.js';

const A = U(77);

type ListReply = 'withA' | 'withoutA' | 'fail';

const listBody = (reply: ListReply) =>
  reply === 'fail'
    ? { status: 503 }
    : { status: 200, body: { conversations: reply === 'withA' ? [summary(), summary({ id: A, name: 'a' })] : [summary()], next_cursor: null } };

/** 복귀 절차를 마친 소스. `hold(n)` 뒤 목록 GET n개는 `release(i, reply)` 할 때까지 응답하지 않는다. */
async function ready() {
  const box: { server?: FakeServer } = {};
  let holdCount = 0;
  const held: Array<(reply: ListReply) => void> = [];
  let mode: ListReply = 'withoutA';
  const fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, 'https://oms.test');
    const isList = (init?.method ?? 'GET') === 'GET' && url.pathname === '/api/conversations';
    if (!isList || holdCount === 0) return box.server!.fetch(input, init);
    holdCount -= 1;
    return new Promise((resolve) => {
      held.push((reply) => {
        const r = listBody(reply);
        resolve(new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status }));
      });
    });
  };
  const ctx = setup({ fetch });
  box.server = ctx.server;
  ctx.server.on('GET /api/conversations', () => listBody(mode));
  ctx.server.on(`POST /api/conversations/${A}/join`, () => ({ status: 200, body: { id: A } }));
  writeCheckpoint(ME, 0, ctx.storage);
  ctx.ds.open?.(CONV);
  expect(await ctx.ds.resume()).toBe(true);
  const settle = async () => {
    for (let i = 0; i < 12; i += 1) await flush();
  };
  return {
    ...ctx,
    settle,
    setList: (next: ListReply) => {
      mode = next;
    },
    hold: (n: number) => {
      holdCount = n;
    },
    heldCount: () => held.length,
    release: async (i: number, reply: ListReply) => {
      held[i]!(reply);
      await settle();
    },
  };
}

const hasA = (ds: Awaited<ReturnType<typeof ready>>['ds']) => ds.getSnapshot().spaces.some((s) => s.id === A);

describe('목록 조회 순서 — 오래된 응답 무시·pending 해제 기준', () => {
  it('(a) 참여 재조회 R1 대기 → R2 시작 → R1 실패 → R2 성공: pending 비움', async () => {
    const t = await ready();
    t.hold(2);
    const joined = t.ds.joinChannel!(A);
    await t.settle();
    t.ds.reload?.();
    await t.settle();
    expect(t.heldCount()).toBe(2);
    await t.release(0, 'fail');
    expect(await joined).toEqual({ ok: true, value: A });
    await t.release(1, 'withA');
    expect(hasA(t.ds)).toBe(true);
    expect(t.ds.getSnapshot().pendingIds).toEqual([]);
  });

  it('(b) 참여 전 시작된 R1 대기 → 참여·R2 성공으로 A 반영 → R1 완료: A 유지', async () => {
    const t = await ready();
    t.hold(1);
    t.ds.reload?.();
    await t.settle();
    expect(t.heldCount()).toBe(1);
    t.setList('withA');
    expect(await t.ds.joinChannel!(A)).toEqual({ ok: true, value: A });
    expect(hasA(t.ds)).toBe(true);
    await t.release(0, 'withoutA');
    expect(hasA(t.ds)).toBe(true);
    expect(t.ds.getSnapshot().pendingIds).toEqual([]);
    expect(t.ds.getSnapshot().connection).toBe('connected');
  });

  it('(c) 확정(나중에 시작한 성공 반영) 이후 늦게 도착한 실패는 pending을 되살리지 않는다', async () => {
    const t = await ready();
    t.hold(1);
    const joined = t.ds.joinChannel!(A);
    await t.settle();
    expect(t.heldCount()).toBe(1);
    t.setList('withA');
    t.ds.reload?.();
    await t.settle();
    expect(hasA(t.ds)).toBe(true);
    await t.release(0, 'fail');
    expect(await joined).toEqual({ ok: true, value: A });
    expect(t.ds.getSnapshot().pendingIds).toEqual([]);
    expect(hasA(t.ds)).toBe(true);
  });

  it('(d) 정상 단일 순서: 참여 재조회 성공 → A 반영, pending 없음 / 재조회 실패 → pending', async () => {
    const t = await ready();
    t.setList('withA');
    expect(await t.ds.joinChannel!(A)).toEqual({ ok: true, value: A });
    expect(hasA(t.ds)).toBe(true);
    expect(t.ds.getSnapshot().pendingIds).toEqual([]);

    const u = await ready();
    u.setList('fail');
    expect(await u.ds.joinChannel!(A)).toEqual({ ok: true, value: A });
    expect(u.ds.getSnapshot().pendingIds).toEqual([A]);
  });
});
