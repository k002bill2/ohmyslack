/**
 * W-10j 사용자 조작 경로(실제 LiveApp + 가짜 fetch/WS):
 * 다른 멤버가 DM 생성 → 탭 복귀 → 사이드바에 DM → 채널에서 @멘션 전송(요청 본문에 ID) → 채널 나가기 → 다시 참여.
 * 재조회 트리거 3종(visibilitychange·WS 재연결·sync.required)도 같은 루트로 확인한다.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { messageCreateRequestSchema } from '../../../../packages/shared/src/index.js';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource, type HttpDataSource } from '../../src/data/http-source.js';
import { failureText } from '../../src/features/spaces';
import { LEAVE_CHANNEL_COPY, LEFT_CHANNEL_COPY } from '../../src/ui/copy.js';
import { CONV, FakeServer, ME, MemoryStorage, PEER, U, flush, message, summary } from '../sync/fake-server.js';

afterEach(cleanup);

const DM = U(11);
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

function world() {
  const server = new FakeServer();
  const state = { dm: false, left: false, posts: [] as unknown[] };
  server.on('GET /api/conversations', () => ({
    status: 200,
    body: {
      conversations: [
        ...(state.left ? [] : [summary()]),
        ...(state.dm ? [summary({ id: DM, kind: 'dm', name: null, peer_user_id: PEER })] : []),
      ],
      next_cursor: null,
    },
  }));
  server.on(`GET /api/conversations/${CONV}/members`, () => ({
    status: 200,
    body: { members: [{ id: ME, display_name: 'A' }, { id: PEER, display_name: 'B' }] },
  }));
  server.on(`GET /api/conversations/${DM}/messages`, () => ({ status: 200, body: { messages: [], has_more: false } }));
  server.on(`GET /api/conversations/${DM}/members`, () => ({ status: 200, body: { members: [] } }));
  server.on(`POST /api/conversations/${CONV}/messages`, (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { client_message_id: string; body: string; mention_user_ids?: string[] };
    state.posts.push(body);
    const m = message(1, { author_id: ME, client_message_id: body.client_message_id, body: body.body, mention_user_ids: body.mention_user_ids ?? [] });
    return { status: 201, body: { message: m, seq: 1, change_id: 1, mention_user_ids: body.mention_user_ids ?? [] } };
  });
  server.on(`DELETE /api/conversations/${CONV}/membership`, () => {
    state.left = true;
    return { status: 204 };
  });
  server.on(`POST /api/conversations/${CONV}/join`, () => {
    state.left = false;
    return { status: 200, body: { id: CONV } };
  });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const timers: (() => void)[] = [];
  const sources: HttpDataSource[] = [];
  render(
    <LiveApp
      fetch={server.fetch}
      createSource={(deps) => {
        const ds = createHttpDataSource({
          ...deps,
          wsUrl: 'wss://oms.test/api/ws',
          createSocket: server.createSocket,
          storage: new MemoryStorage(),
          isOnline: () => true,
          setTimer: (fn) => timers.push(fn),
          clearTimer: () => undefined,
          lifecycle: { doc, win: new EventTarget() },
        });
        sources.push(ds);
        return ds;
      }}
    />,
  );
  const listCalls = () => server.log.filter((l) => l === 'GET /api/conversations').length;
  return { server, state, doc, timers, sources, listCalls };
}

const nav = () => screen.getByRole('navigation', { name: '공간' });

describe('LiveApp 사용자 시나리오(W-10j)', () => {
  it('새 DM 재조회 → @멘션 전송 → 채널 나가기 → 다시 참여', async () => {
    const w = world();
    await settle();
    expect(within(nav()).getByRole('button', { name: 'general' })).toBeTruthy();
    expect(within(nav()).queryByRole('button', { name: 'B' })).toBeNull();

    // 1) 다른 멤버가 DM을 만들었다(서버 이벤트 없음) → 탭 복귀 → 목록 재조회로 사이드바에 나타난다.
    w.state.dm = true;
    await act(async () => {
      w.doc.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    expect(within(nav()).getByRole('button', { name: 'B' })).toBeTruthy();

    // 2) 채널에서 @멘션 → 후보(자기 제외) → Enter 선택 → 전송 본문에 mention_user_ids.
    fireEvent.click(within(nav()).getByRole('button', { name: 'general' }));
    await settle();
    const box = screen.getByLabelText('#general에 메시지 작성') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '@' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['B']);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('@B ');
    fireEvent.change(box, { target: { value: '@B 안녕' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await settle();
    expect(w.state.posts).toHaveLength(1);
    const post = w.state.posts[0] as { mention_user_ids?: string[] };
    expect(messageCreateRequestSchema.safeParse(post).success).toBe(true);
    expect(post.mention_user_ids).toEqual([PEER]);

    // 3) 채널 나가기 → 확인 Dialog → DELETE → 구독 해제 → 사이드바 muted + 「나간 채널 · 다시 참여」, 작성기 숨김.
    fireEvent.click(screen.getByRole('button', { name: LEFT_CHANNEL_COPY.leave }));
    const dialog = screen.getByRole('dialog', { name: LEAVE_CHANNEL_COPY.title });
    expect(within(dialog).getByText(LEAVE_CHANNEL_COPY.body)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: LEAVE_CHANNEL_COPY.confirm }));
    await settle();
    expect(w.server.log).toContain(`DELETE /api/conversations/${CONV}/membership`);
    expect(w.server.log.at(w.server.log.lastIndexOf(`DELETE /api/conversations/${CONV}/membership`) + 1)).toBe('ws conversation.unsubscribe');
    expect(screen.queryByRole('dialog')).toBeNull();
    const row = within(nav()).getByRole('button', { name: 'general' });
    expect(row.className).toContain('space-left');
    expect(within(nav()).getByRole('button', { name: LEFT_CHANNEL_COPY.rejoinRow })).toBeTruthy();
    expect(screen.queryByLabelText('#general에 메시지 작성')).toBeNull();
    expect(screen.getByText(LEFT_CHANNEL_COPY.notice)).toBeTruthy();
    expect(screen.queryByRole('button', { name: LEFT_CHANNEL_COPY.leave })).toBeNull();
    // DM에는 나가기 없음.
    fireEvent.click(within(nav()).getByRole('button', { name: 'B' }));
    await settle();
    expect(screen.queryByRole('button', { name: LEFT_CHANNEL_COPY.leave })).toBeNull();
    fireEvent.click(within(nav()).getByRole('button', { name: 'general' }));
    await settle();
    // 나간 채널은 다시 선택해도 구독하지 않는다.
    const subsBefore = w.server.log.filter((l) => l === 'ws conversation.subscribe').length;

    // 4) 다시 참여 → join → 이력·구독 재개 → 기본 상태.
    fireEvent.click(within(nav()).getByRole('button', { name: LEFT_CHANNEL_COPY.rejoinRow }));
    await settle();
    expect(w.server.log).toContain(`POST /api/conversations/${CONV}/join`);
    expect(w.server.log.filter((l) => l === 'ws conversation.subscribe').length).toBe(subsBefore + 1);
    expect(within(nav()).getByRole('button', { name: 'general' }).className).not.toContain('space-left');
    expect(within(nav()).queryByRole('button', { name: LEFT_CHANNEL_COPY.rejoinRow })).toBeNull();
    expect(screen.getByLabelText('#general에 메시지 작성')).toBeTruthy();
    expect(screen.getByRole('button', { name: LEFT_CHANNEL_COPY.leave })).toBeTruthy();
  });

  it('헤더 「다시 참여」·안내 「참여」도 join으로 기본 상태 복귀', async () => {
    const w = world();
    await settle();
    fireEvent.click(within(nav()).getByRole('button', { name: 'general' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: LEFT_CHANNEL_COPY.leave }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: LEAVE_CHANNEL_COPY.confirm }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: LEFT_CHANNEL_COPY.join }));
    await settle();
    expect(screen.getByLabelText('#general에 메시지 작성')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: LEFT_CHANNEL_COPY.leave }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: LEAVE_CHANNEL_COPY.confirm }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: LEFT_CHANNEL_COPY.rejoin }));
    await settle();
    expect(screen.getByLabelText('#general에 메시지 작성')).toBeTruthy();
    expect(w.server.log.filter((l) => l === `POST /api/conversations/${CONV}/join`)).toHaveLength(2);
  });

  it('나가기 실패(5xx) → Dialog 유지 + 오류, 사이드바는 그대로', async () => {
    const w = world();
    w.server.on(`DELETE /api/conversations/${CONV}/membership`, () => ({ status: 500 }));
    await settle();
    fireEvent.click(within(nav()).getByRole('button', { name: 'general' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: LEFT_CHANNEL_COPY.leave }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: LEAVE_CHANNEL_COPY.confirm }));
    await settle();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByText(failureText({ status: 500 }))).toBeTruthy();
    expect(within(nav()).queryByRole('button', { name: LEFT_CHANNEL_COPY.rejoinRow })).toBeNull();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '취소' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('대화 목록 재조회 트리거(서버 이벤트 없이 새 대화 표시)', () => {
  it('visibilitychange(visible)', async () => {
    const w = world();
    await settle();
    const before = w.listCalls();
    w.state.dm = true;
    await act(async () => {
      w.doc.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    expect(w.listCalls()).toBeGreaterThan(before);
    expect(within(nav()).getByRole('button', { name: 'B' })).toBeTruthy();
  });

  it('WS 재연결 완료', async () => {
    const w = world();
    await settle();
    const before = w.listCalls();
    w.state.dm = true;
    await act(async () => {
      w.server.socket.serverClose(1006);
    });
    await settle();
    expect(within(nav()).queryByRole('button', { name: 'B' })).toBeNull();
    await act(async () => {
      w.timers.shift()?.();
    });
    await settle();
    expect(w.listCalls()).toBeGreaterThan(before);
    expect(within(nav()).getByRole('button', { name: 'B' })).toBeTruthy();
  });

  it('sync.required 처리 후', async () => {
    const w = world();
    await settle();
    const before = w.listCalls();
    w.state.dm = true;
    await act(async () => {
      w.server.socket.push({ type: 'sync.required' });
    });
    await settle();
    expect(w.listCalls()).toBeGreaterThan(before);
    expect(within(nav()).getByRole('button', { name: 'B' })).toBeTruthy();
  });
});

