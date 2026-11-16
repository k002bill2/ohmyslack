/** 오프라인으로 못 보낸 메시지는 `online` 복귀 때 같은 ID로 한 번 자동 재전송(2026-11-17 결정, UI_STATES §2-5) — 데이터 소스 배선. */
import { afterEach, describe, expect, it } from 'vitest';
import { CONV, U, flush, setup } from './fake-server.js';

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await flush();
};

function mount() {
  let online = false;
  let id = 0;
  const ctx = setup({
    isOnline: () => online,
    lifecycle: { doc: document, win: window },
    newClientMessageId: () => U(900 + (id += 1)),
  });
  const posts: Record<string, unknown>[] = [];
  ctx.server.on(`POST /api/conversations/${CONV}/messages`, (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posts.push(body);
    return { status: 500 };
  });
  return { ...ctx, posts, goOnline: () => { online = true; window.dispatchEvent(new Event('online')); } };
}

let stopAll: (() => void) | null = null;
afterEach(() => {
  stopAll?.();
  stopAll = null;
});

describe('오프라인 메시지 자동 재전송 배선', () => {
  it('online 이벤트에 오프라인 실패 항목(스레드 답글 포함)을 같은 client_message_id·thread_root_id로 순서대로 1회 보낸다', async () => {
    const { ds, posts, goOnline } = mount();
    void ds.start();
    stopAll = () => ds.stop();
    await settle();
    ds.send({ conversationId: CONV }, '본문');
    ds.send({ conversationId: CONV, rootId: U(101) }, '답글');
    await settle();
    expect(posts).toHaveLength(0);
    goOnline();
    await settle();
    expect(posts.map((p) => [p.client_message_id, p.body, p.thread_root_id])).toEqual([
      [U(901), '본문', undefined],
      [U(902), '답글', U(101)],
    ]);
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(posts).toHaveLength(2);
  });

  it('로그아웃 뒤에는 online 이벤트가 와도 보내지 않는다', async () => {
    const { ds, posts, goOnline, server } = mount();
    server.on('POST /api/auth/logout', () => ({ status: 204 }));
    void ds.start();
    await settle();
    ds.send({ conversationId: CONV }, '남은 본문');
    await settle();
    await ds.logout();
    goOnline();
    await settle();
    expect(posts).toHaveLength(0);
  });
});
