/** Codex r3 P2 근본 수정: 동작은 성공했지만 목록 재조회가 실패한 대화를 데이터 계층이 `pendingIds`로 알린다. */
import { describe, expect, it } from 'vitest';
import { writeCheckpoint } from '../../src/features/sync';
import { CONV, ME, U, flush, setup, summary } from './fake-server.js';

const A = U(77);

/** 복귀 절차를 마친 소스 + 목록 응답 전환('ok'=C(+A), 'fail'=503). A 참여는 성공한다. */
async function ready() {
  const ctx = setup();
  let list: 'ok' | 'fail' = 'ok';
  let withA = false;
  ctx.server.on('GET /api/conversations', () =>
    list === 'fail' ? { status: 503 } : { status: 200, body: { conversations: withA ? [summary(), summary({ id: A, name: 'a' })] : [summary()], next_cursor: null } },
  );
  ctx.server.on(`POST /api/conversations/${A}/join`, () => ({ status: 200, body: { id: A } }));
  writeCheckpoint(ME, 0, ctx.storage);
  ctx.ds.open?.(CONV);
  expect(await ctx.ds.resume()).toBe(true);
  const setList = (next: 'ok' | 'fail', includeA = false) => {
    list = next;
    withA = includeA;
  };
  /** 목록 조회 성공 경로(복귀 절차). */
  const reloadList = async () => {
    ctx.ds.reload?.();
    for (let i = 0; i < 8; i += 1) await flush();
  };
  return { ...ctx, setList, reloadList };
}

describe('snapshot pendingIds — 목록 미반영 대화', () => {
  it('(a) 참여 성공 + 목록 재조회 실패 → pendingIds에 id, 참여 결과는 성공', async () => {
    const { ds, setList } = await ready();
    setList('fail');
    const res = await ds.joinChannel!(A);
    expect(res).toEqual({ ok: true, value: A });
    expect(ds.getSnapshot().pendingIds).toEqual([A]);
  });

  it('(b) 이후 목록 조회가 성공하면 비운다 — 목록에 없어도', async () => {
    const { ds, setList, reloadList } = await ready();
    setList('fail');
    await ds.joinChannel!(A);
    setList('ok', false);
    await reloadList();
    expect(ds.getSnapshot().spaces.some((s) => s.id === A)).toBe(false);
    expect(ds.getSnapshot().pendingIds).toEqual([]);
  });

  it('(b) 이후 목록 조회가 성공하면 비운다 — 목록에 있으면', async () => {
    const { ds, setList, reloadList } = await ready();
    setList('fail');
    await ds.joinChannel!(A);
    setList('ok', true);
    await reloadList();
    expect(ds.getSnapshot().spaces.some((s) => s.id === A)).toBe(true);
    expect(ds.getSnapshot().pendingIds).toEqual([]);
  });

  it('(c) 재조회가 성공하면 처음부터 pending 없음', async () => {
    const { ds, setList } = await ready();
    setList('ok', true);
    await ds.joinChannel!(A);
    expect(ds.getSnapshot().pendingIds).toEqual([]);
  });

  it('나가기 뒤 재조회 실패는 pending으로 표시하지 않는다(도착이 아님)', async () => {
    const { ds, server, setList } = await ready();
    server.on(`DELETE /api/conversations/${CONV}/membership`, () => ({ status: 204 }));
    setList('fail');
    await ds.leaveChannel!(CONV);
    expect(ds.getSnapshot().pendingIds).toEqual([]);
  });

  it('로그아웃(세션 종료) 시 비운다', async () => {
    const { ds, server, setList } = await ready();
    server.on('POST /api/auth/logout', () => ({ status: 204 }));
    setList('fail');
    await ds.joinChannel!(A);
    expect(ds.getSnapshot().pendingIds).toEqual([A]);
    await ds.logout();
    expect(ds.getSnapshot().pendingIds).toEqual([]);
  });
});
