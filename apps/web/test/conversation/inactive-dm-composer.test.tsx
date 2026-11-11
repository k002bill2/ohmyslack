/**
 * G-52: 상대가 비활성화된 DM은 작성기(본문·스레드 답글) 대신 안내를 보인다 — 서버는 이 DM 쓰기를 403으로 거절한다.
 * 읽기·스레드 열기는 그대로. 활성 DM·채널은 변화 없음. 화면이 아직 활성으로 아는 사이 403이 오면 기존 실패 상태가 보인다.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from '../../src/features/layout';
import { writeCheckpoint } from '../../src/features/sync';
import { COMPOSER_COPY } from '../../src/ui/copy.js';
import { installViewport } from '../helpers/viewport.js';
import { CONV, ME, PEER, U, flush, message, setup, summary } from '../sync/fake-server.js';

afterEach(cleanup);

const GONE = U(3);
const DM = U(11);
const ROOT = U(101);
const NOTICE = '비활성화된 멤버라 메시지를 보낼 수 없습니다';
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await act(flush);
};

/** DM 하나(상대 `peer`) + 채널 general. `disabled`면 `/api/users/names`가 상대를 비활성으로 돌려준다. */
async function mount(peer: string, options: { readonly disabled?: boolean; readonly post?: number; readonly serverReplies?: number } = {}) {
  installViewport(1400);
  let id = 0;
  const ctx = setup({ newClientMessageId: () => U(900 + (id += 1)) });
  const posts: string[] = [];
  ctx.server.on('GET /api/conversations', () => ({
    status: 200,
    body: { conversations: [summary(), summary({ id: DM, kind: 'dm', name: null, peer_user_id: peer })], next_cursor: null },
  }));
  const replyCount = options.serverReplies ?? 0;
  const rootMsg = message(1, { conversation_id: DM, author_id: peer, body: '예전 글', root_reply_count: replyCount });
  const serverReplies = Array.from({ length: replyCount }, (_, i) =>
    message(2 + i, { conversation_id: DM, author_id: peer, body: `서버 답글 ${i + 1}`, thread_root_id: ROOT }),
  );
  ctx.server.on(`GET /api/conversations/${DM}/messages`, () => ({
    status: 200,
    body: { messages: [rootMsg], has_more: false },
  }));
  ctx.server.on(`GET /api/conversations/${DM}/members`, () => ({ status: 200, body: { members: [{ id: ME, display_name: 'A' }] } }));
  ctx.server.on(`GET /api/messages/${ROOT}/replies`, () => ({
    status: 200,
    body: { root: rootMsg, replies: serverReplies, has_more: false },
  }));
  ctx.server.on('GET /api/users/names', () => ({
    status: 200,
    body: { users: options.disabled === true ? [{ id: peer, display_name: '떠난이', status: 'disabled', kind: 'human' }] : [] },
  }));
  ctx.server.on(`POST /api/conversations/${DM}/messages`, (_url, init) => {
    posts.push(String(init?.body));
    return { status: options.post ?? 403, body: { error: 'forbidden' } };
  });
  ctx.server.on(`POST /api/conversations/${CONV}/messages`, () => ({ status: 500, body: { error: 'internal' } }));
  writeCheckpoint(ME, 3, ctx.storage);
  render(<AppShell dataSource={ctx.ds} />);
  await act(async () => {
    await ctx.ds.resume();
  });
  await settle();
  return { ...ctx, posts, user: userEvent.setup() };
}

async function openDm(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name }));
  await settle();
}

async function openThread(user: ReturnType<typeof userEvent.setup>) {
  const trigger = document.querySelector<HTMLElement>(`[data-reply-for="${ROOT}"]`);
  if (trigger === null) throw new Error('답글 버튼 없음');
  await user.click(trigger);
  await settle();
  return screen.getByRole('complementary', { name: '스레드' });
}

describe('G-52 비활성 상대 DM 작성기 잠금', () => {
  it('문구 상수는 정본 문구 그대로', () => {
    expect(COMPOSER_COPY.inactivePeer).toBe(NOTICE);
  });

  it('본문: 작성기 대신 role=status 안내, 입력란·전송 버튼 없음, 기존 메시지는 그대로 읽힌다', async () => {
    const { user } = await mount(GONE, { disabled: true });
    await openDm(user, '떠난이 (비활성)');
    const pane = screen.getByRole('main');
    expect(within(pane).getByText('예전 글')).toBeTruthy();
    const notice = within(pane).getByText(NOTICE);
    expect(notice.closest('[role="status"]')).not.toBeNull();
    expect(within(pane).queryByRole('textbox')).toBeNull();
    expect(within(pane).queryByRole('button', { name: '전송' })).toBeNull();
  });

  it('스레드: 열 수 있고 답글 작성기 대신 같은 안내, 포커스는 닫기 버튼', async () => {
    const { user } = await mount(GONE, { disabled: true });
    await openDm(user, '떠난이 (비활성)');
    const panel = await openThread(user);
    expect(within(panel).getAllByText('예전 글').length).toBeGreaterThan(0);
    const notice = within(panel).getByText(NOTICE);
    expect(notice.closest('[role="status"]')).not.toBeNull();
    expect(within(panel).queryByRole('textbox')).toBeNull();
    expect(within(panel).queryByRole('button', { name: '전송' })).toBeNull();
    expect(document.activeElement).toBe(within(panel).getByRole('button', { name: '닫기' }));
  });

  it('활성 DM: 본문·스레드 작성기 그대로, 안내 없음', async () => {
    const { user } = await mount(PEER);
    await openDm(user, 'B');
    const pane = screen.getByRole('main');
    expect(within(pane).getByRole('textbox', { name: 'B에 메시지 작성' })).toBeTruthy();
    expect(within(pane).getByRole('button', { name: '전송' })).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
    const panel = await openThread(user);
    expect(within(panel).getByRole('textbox', { name: COMPOSER_COPY.replyLabel })).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('채널: 작성기 그대로, 안내 없음', async () => {
    const { user } = await mount(GONE, { disabled: true });
    await openDm(user, 'general');
    const pane = screen.getByRole('main');
    expect(within(pane).getByRole('textbox', { name: '#general에 메시지 작성' })).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});

describe('G-52 경합: 화면은 활성으로 알지만 서버가 403', () => {
  it('보낸 메시지는 기존 실패 상태(「전송 실패 · 다시 시도」)로 남는다', async () => {
    const { user, posts } = await mount(PEER);
    await openDm(user, 'B');
    const pane = screen.getByRole('main');
    await user.type(within(pane).getByRole('textbox', { name: 'B에 메시지 작성' }), '안녕');
    await user.click(within(pane).getByRole('button', { name: '전송' }));
    await settle();
    expect(posts).toHaveLength(1);
    expect(within(pane).getByText('안녕')).toBeTruthy();
    expect(within(pane).getByRole('button', { name: '전송 실패 · 다시 시도' })).toBeTruthy();
    expect(within(pane).getByRole('button', { name: '삭제' })).toBeTruthy();
    // 다시 확인한 결과 비활성이 아니면(응답에 없음) 이름·작성기를 건드리지 않는다.
    expect(within(pane).getByRole('heading', { level: 1, name: 'B' })).toBeTruthy();
    expect(within(pane).getByRole('textbox', { name: 'B에 메시지 작성' })).toBeTruthy();
  });

  it('403 뒤 이름 재확인이 실패해도 활성 상대 이름·작성기는 그대로', async () => {
    const { user, server } = await mount(PEER);
    server.on('GET /api/users/names', () => ({ status: 500 }));
    await openDm(user, 'B');
    const pane = screen.getByRole('main');
    await user.type(within(pane).getByRole('textbox', { name: 'B에 메시지 작성' }), '안녕');
    await user.click(within(pane).getByRole('button', { name: '전송' }));
    await settle();
    expect(within(pane).getByRole('button', { name: '전송 실패 · 다시 시도' })).toBeTruthy();
    expect(within(pane).getByRole('heading', { level: 1, name: 'B' })).toBeTruthy();
    expect(within(pane).getByRole('textbox', { name: 'B에 메시지 작성' })).toBeTruthy();
  });

  it('403 뒤 상대 이름을 다시 확인해 비활성이면 작성기를 잠근다(실패 항목은 「삭제」만 — 다시 시도는 매번 403)', async () => {
    const { user } = await mount(PEER, { disabled: true });
    await openDm(user, 'B');
    const pane = screen.getByRole('main');
    await user.type(within(pane).getByRole('textbox', { name: 'B에 메시지 작성' }), '안녕');
    await user.click(within(pane).getByRole('button', { name: '전송' }));
    await settle();
    expect(within(pane).getByText('안녕')).toBeTruthy();
    expect(within(pane).getByText('전송 실패')).toBeTruthy();
    expect(within(pane).queryByRole('button', { name: '전송 실패 · 다시 시도' })).toBeNull();
    expect(within(pane).getByRole('button', { name: '삭제' })).toBeTruthy();
    expect(within(pane).getByText(NOTICE).closest('[role="status"]')).not.toBeNull();
    expect(within(pane).queryByRole('textbox')).toBeNull();
  });

  it('잠긴 DM 스레드의 실패 답글도 「삭제」만', async () => {
    const { user } = await mount(PEER, { disabled: true });
    await openDm(user, 'B');
    const panel = await openThread(user);
    await user.type(within(panel).getByRole('textbox', { name: COMPOSER_COPY.replyLabel }), '답글{Enter}');
    await settle();
    expect(within(panel).getByText('답글')).toBeTruthy();
    expect(within(panel).getByText('전송 실패')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: '전송 실패 · 다시 시도' })).toBeNull();
    expect(within(panel).getByRole('button', { name: '삭제' })).toBeTruthy();
  });

  it('활성 DM 스레드의 실패 답글은 「다시 시도」·「삭제」 그대로', async () => {
    const { user } = await mount(PEER, { post: 500 });
    await openDm(user, 'B');
    const panel = await openThread(user);
    await user.type(within(panel).getByRole('textbox', { name: COMPOSER_COPY.replyLabel }), '답글{Enter}');
    await settle();
    expect(within(panel).getByRole('button', { name: '전송 실패 · 다시 시도' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: '삭제' })).toBeTruthy();
  });

  it('채널의 실패 항목은 「다시 시도」·「삭제」 그대로', async () => {
    const { user } = await mount(GONE, { disabled: true });
    await openDm(user, 'general');
    const pane = screen.getByRole('main');
    await user.type(within(pane).getByRole('textbox', { name: '#general에 메시지 작성' }), '안녕{Enter}');
    await settle();
    expect(within(pane).getByRole('button', { name: '전송 실패 · 다시 시도' })).toBeTruthy();
    expect(within(pane).getByRole('button', { name: '삭제' })).toBeTruthy();
  });

  it('다른 실패(500)는 이름을 다시 확인하지 않는다', async () => {
    const { user, server } = await mount(PEER, { disabled: true, post: 500 });
    await openDm(user, 'B');
    const before = server.log.filter((l) => l.startsWith('GET /api/users/names')).length;
    const pane = screen.getByRole('main');
    await user.type(within(pane).getByRole('textbox', { name: 'B에 메시지 작성' }), '안녕');
    await user.click(within(pane).getByRole('button', { name: '전송' }));
    await settle();
    expect(server.log.filter((l) => l.startsWith('GET /api/users/names')).length).toBe(before);
    expect(within(pane).getByRole('textbox', { name: 'B에 메시지 작성' })).toBeTruthy();
  });
});


describe('G-52 경합 뒤 포커스: 사라진 작성기의 포커스를 새 안내로(스레드 2639d27과 같은 규칙)', () => {
  it('메인 작성기에 포커스가 있던 채 잠기면 포커스는 메인 안내(role=status)로', async () => {
    const { user } = await mount(PEER, { disabled: true });
    await openDm(user, 'B');
    const pane = screen.getByRole('main');
    await user.type(within(pane).getByRole('textbox', { name: 'B에 메시지 작성' }), '안녕{Enter}');
    await settle();
    const notice = within(pane).getByText(NOTICE);
    expect(notice.closest('[role="status"]')).not.toBeNull();
    expect(document.activeElement).toBe(notice);
  });

  it('포커스가 작성기 밖(사이드바)에 있으면 잠겨도 빼앗지 않는다', async () => {
    const { user, ds } = await mount(PEER, { disabled: true });
    await openDm(user, 'B');
    const general = within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: 'general' });
    general.focus();
    await act(async () => {
      ds.send({ conversationId: DM }, '안녕');
    });
    await settle();
    expect(screen.getByRole('main').querySelector('.composer-notice')).not.toBeNull();
    expect(document.activeElement).toBe(general);
  });

  it('열린 스레드 작성기에서 잠기면 포커스는 스레드 닫기 버튼(메인 안내가 가져가지 않음)', async () => {
    const { user } = await mount(PEER, { disabled: true });
    await openDm(user, 'B');
    const panel = await openThread(user);
    await user.type(within(panel).getByRole('textbox', { name: COMPOSER_COPY.replyLabel }), '답글{Enter}');
    await settle();
    expect(within(panel).getByText(NOTICE)).toBeTruthy();
    expect(document.activeElement).toBe(within(panel).getByRole('button', { name: '닫기' }));
  });
});

describe('스레드 헤더 답글 수', () => {
  it('서버 확정 답글만 센다 — 실패한 로컬 답글은 목록에만 보인다(메인 칩과 일치)', async () => {
    const { user } = await mount(PEER, { post: 500, serverReplies: 1 });
    await openDm(user, 'B');
    const panel = await openThread(user);
    await user.type(within(panel).getByRole('textbox', { name: COMPOSER_COPY.replyLabel }), '로컬 답글{Enter}');
    await settle();
    expect(within(panel).getByText('서버 답글 1')).toBeTruthy();
    expect(within(panel).getByText('로컬 답글')).toBeTruthy();
    expect(within(panel).getByText('전송 실패')).toBeTruthy();
    expect(panel.querySelector('.thread-subtitle')?.textContent).toBe('B · 답글 1');
  });
});
