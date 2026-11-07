/**
 * W-10i 사용자 시나리오(실제 LiveApp + 가짜 fetch/WS): 보내기 → 수정 → 답글 2개 수신 → 「답글 2」 → 스레드 열기(주소)
 * → 새로고침 복원 → 뒤로가기 닫힘 → 원문 삭제 → 자리표시자 + 요약 유지. 다른 기기 수정·삭제 이벤트 반영.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LiveApp } from '../../src/LiveApp.js';
import { createMemoryHistory, type MemoryHistory } from '../../src/app/route.js';
import { createHttpDataSource } from '../../src/data/http-source.js';
import { CONV, FakeServer, ME, MemoryStorage, PEER, U, flush, message, summary } from '../sync/fake-server.js';
import { installViewport } from '../helpers/viewport.js';

afterEach(cleanup);
beforeEach(() => installViewport(1400));

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

const MINE = U(300);
const CMID = U(900);

function mount(server: FakeServer, history: MemoryHistory) {
  const storage = new MemoryStorage();
  render(
    <LiveApp
      fetch={server.fetch}
      history={history}
      replacePath={() => undefined}
      createSource={(deps) =>
        createHttpDataSource({
          ...deps,
          wsUrl: 'wss://oms.test/api/ws',
          createSocket: server.createSocket,
          storage,
          isOnline: () => true,
          newClientMessageId: () => CMID,
          setTimer: () => 0,
          clearTimer: () => undefined,
        })
      }
    />,
  );
}

/** 서버 상태(원문 1건 + 답글) — 각 경로가 같은 상태를 돌려준다. */
function scenarioServer() {
  const server = new FakeServer();
  let root = message(1, { id: MINE, author_id: ME, client_message_id: CMID, body: '안녕' });
  const replies = [message(2, { thread_root_id: MINE, root_reply_count: null }), message(3, { thread_root_id: MINE, root_reply_count: null })];
  let shownReplies: typeof replies = [];
  let change = 10;
  server.on(`POST /api/conversations/${CONV}/messages`, () => ({
    status: 201,
    body: { message: root, seq: 1, change_id: (change += 1), mention_user_ids: [] },
  }));
  server.on(`PATCH /api/messages/${MINE}`, (_url, init) => {
    root = { ...root, body: JSON.parse(String(init?.body)).body, edited_at: '2026-11-07T00:01:00Z' };
    return { status: 200, body: { message: root, seq: 1, change_id: (change += 1), mention_user_ids: [] } };
  });
  server.on(`DELETE /api/messages/${MINE}`, () => {
    root = { ...root, body: null as unknown as string, deleted_at: '2026-11-07T00:05:00Z' };
    return { status: 200, body: { message_id: MINE, seq: 1, deleted_at: root.deleted_at, change_id: (change += 1) } };
  });
  server.on('GET /api/sync/snapshot', () => ({
    status: 200,
    body: { snapshot_cursor: 0, conversation_id: CONV, messages: [root, ...shownReplies], has_more: false, next_before_seq: null },
  }));
  server.on(`GET /api/messages/${MINE}/replies`, () => ({ status: 200, body: { root, replies: shownReplies, has_more: false } }));
  const pushReplies = () => {
    shownReplies = replies;
    replies.forEach((r, i) => {
      server.socket.push({ type: 'message.created', conversation_id: CONV, change_id: (change += 1), message: r });
      root = { ...root, root_reply_count: i + 1 };
      server.socket.push({ type: 'message.updated', conversation_id: CONV, change_id: change, message: root, mention_user_ids: [] });
    });
  };
  return { server, pushReplies, current: () => root };
}

/** 이력·snapshot 모두 같은 메시지(첫 기기는 snapshot 절차가 fold를 새로 쌓는다). */
function serve(server: FakeServer, messages: readonly unknown[]) {
  server.on(`GET /api/conversations/${CONV}/messages`, () => ({ status: 200, body: { messages, has_more: false } }));
  server.on('GET /api/sync/snapshot', () => ({
    status: 200,
    body: { snapshot_cursor: 0, conversation_id: CONV, messages, has_more: false, next_before_seq: null },
  }));
}

const list = () => screen.getByRole('main');
const item = (name: RegExp) => within(list()).getByRole('listitem', { name });

describe('W-10i LiveApp 시나리오', () => {
  it('보내기 → 수정 → 답글 2 → 스레드(주소·복원·뒤로) → 원문 삭제 → 자리표시자 + 요약 유지', async () => {
    const { server, pushReplies } = scenarioServer();
    const history = createMemoryHistory(`/c/${CONV}`);
    mount(server, history);
    await settle();

    // 보내기
    const composer = within(list()).getByRole('textbox', { name: '#general에 메시지 작성' });
    fireEvent.change(composer, { target: { value: '안녕' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await settle();
    const mine = item(/^A,/);
    expect(within(mine).getByText('안녕')).toBeTruthy();

    // 수정: 인라인 편집기 → Enter 저장 → PATCH → 「(수정됨)」
    fireEvent.click(within(mine).getByRole('button', { name: '수정' }));
    const editor = within(item(/^A,/)).getByRole('textbox', { name: '수정' });
    fireEvent.change(editor, { target: { value: '안녕하세요' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await settle();
    expect(server.log).toContain(`PATCH /api/messages/${MINE}`);
    expect(within(item(/^A,/)).getByText('안녕하세요')).toBeTruthy();
    expect(within(item(/^A,/)).getByText('(수정됨)')).toBeTruthy();

    // 답글 2개 수신 → 요약 「답글 2」
    await act(async () => pushReplies());
    await settle();
    const summaryButton = within(item(/^A,/)).getByRole('button', { name: '답글 2' });

    // 요약 클릭 → `?thread=` push
    fireEvent.click(summaryButton);
    await settle();
    expect(history.entries().at(-1)).toBe(`/c/${CONV}?thread=${MINE}`);
    expect(screen.getByRole('complementary', { name: '스레드' })).toBeTruthy();

    // 뒤로가기 → 닫힘
    act(() => history.back());
    await settle();
    expect(screen.queryByRole('complementary', { name: '스레드' })).toBeNull();
    cleanup();

    // 새로고침(주소 직접 진입) → 복원
    const reloaded = createMemoryHistory(`/c/${CONV}?thread=${MINE}`);
    mount(server, reloaded);
    await settle();
    const panel = screen.getByRole('complementary', { name: '스레드' });
    expect(within(panel).getAllByRole('listitem')).toHaveLength(3);

    // 원문 삭제(본문 목록에서) → 확인 Dialog → DELETE → 자리표시자 + 요약 유지
    fireEvent.click(within(item(/^A,/)).getByRole('button', { name: '삭제' }));
    const dialog = screen.getByRole('dialog', { name: '메시지 삭제' });
    fireEvent.click(within(dialog).getByRole('button', { name: '삭제' }));
    await settle();
    expect(server.log).toContain(`DELETE /api/messages/${MINE}`);
    expect(screen.queryByRole('dialog', { name: '메시지 삭제' })).toBeNull();
    const deleted = item(/^A,/);
    expect(within(deleted).getByText('삭제된 메시지입니다')).toBeTruthy();
    expect(within(deleted).queryByText('안녕하세요')).toBeNull();
    expect(within(deleted).queryByRole('button', { name: '삭제' })).toBeNull();
    expect(within(deleted).getByRole('button', { name: '답글 2' })).toBeTruthy();
    expect(document.activeElement).toBe(deleted);
    // 스레드 원문 자리도 자리표시자, 답글 열람 유지
    expect(within(screen.getByRole('complementary', { name: '스레드' })).getByText('삭제된 메시지입니다')).toBeTruthy();

    // 닫기 → `?thread=` 제거
    fireEvent.click(within(screen.getByRole('complementary', { name: '스레드' })).getByRole('button', { name: '닫기' }));
    await settle();
    expect(reloaded.pathname()).toBe(`/c/${CONV}`);
    expect(reloaded.search?.()).toBe('');
  });

  it('다른 기기 message.updated·message.deleted → 본문 교체·「(수정됨)」·자리표시자', async () => {
    const server = new FakeServer();
    const other = message(1, { author_id: PEER });
    serve(server, [other]);
    mount(server, createMemoryHistory(`/c/${CONV}`));
    await settle();
    expect(within(item(/^B,/)).getByText('m1')).toBeTruthy();
    // 타인 메시지에는 수정·삭제가 없다
    expect(within(item(/^B,/)).queryByRole('button', { name: '수정' })).toBeNull();
    expect(within(item(/^B,/)).queryByRole('button', { name: '삭제' })).toBeNull();

    await act(async () =>
      server.socket.push({
        type: 'message.updated',
        conversation_id: CONV,
        change_id: 50,
        message: { ...other, body: 'm1 고침', edited_at: '2026-11-07T00:02:00Z' },
        mention_user_ids: [],
      }),
    );
    await settle();
    expect(within(item(/^B,/)).getByText('m1 고침')).toBeTruthy();
    expect(within(item(/^B,/)).getByText('(수정됨)')).toBeTruthy();

    await act(async () =>
      server.socket.push({ type: 'message.deleted', conversation_id: CONV, change_id: 51, message_id: other.id, deleted_at: '2026-11-07T00:03:00Z' }),
    );
    await settle();
    expect(within(item(/^B,/)).getByText('삭제된 메시지입니다')).toBeTruthy();
    expect(within(item(/^B,/)).queryByText('m1 고침')).toBeNull();
  });

  it('unread_threads[] 대상 스레드는 점 + 「새 답글」, 대상이 아니면 숫자만', async () => {
    const server = new FakeServer();
    const a = message(1, { root_reply_count: 3 });
    const b = message(2, { root_reply_count: 1 });
    serve(server, [a, b]);
    server.on('GET /api/conversations', () => ({
      status: 200,
      body: {
        conversations: [
          summary({
            unread_thread_count: 1,
            unread_threads: [{ root_message_id: a.id, last_read_seq: 0, last_reply_seq: 9, unread_reply_count: 2, mention_count: 0 }],
          }),
        ],
        next_cursor: null,
      },
    }));
    mount(server, createMemoryHistory(`/c/${CONV}`));
    await settle();
    const [first, second] = within(list()).getAllByRole('listitem');
    expect(within(first as HTMLElement).getByRole('button', { name: '답글 3 새 답글' })).toBeTruthy();
    expect(within(second as HTMLElement).getByRole('button', { name: '답글 1' })).toBeTruthy();
    expect(within(second as HTMLElement).queryByText('새 답글')).toBeNull();
  });
});
