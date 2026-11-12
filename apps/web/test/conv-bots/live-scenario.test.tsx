/**
 * FR-BOT-11 사용자 시나리오(실제 LiveApp + http-source + 가짜 fetch/WS):
 * owner 계정으로 메시지가 있는 채널 열기 → 봇 추가(POST 본문 bot_user_id) → 멤버 수·멘션 후보 배지 → 제거 확인(DELETE) → 후보에서 빠짐.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource } from '../../src/data/http-source.js';
import { BOT_BADGE_TEXT, BOT_CHANNEL_COPY } from '../../src/ui/copy.js';
import { headerMenuItems, selectHeaderMenuItem } from './header-menu.js';
import { CONV, FakeServer, ME, MemoryStorage, PEER, U, flush, message } from '../sync/fake-server.js';

afterEach(() => {
  cleanup();
  // LiveApp은 주소(/c/:id)를 복원한다 — 다음 시나리오가 목록 화면에서 시작하게 되돌린다.
  window.history.replaceState(null, '', '/');
});

const BOT = U(9);
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

function world(role: 'owner' | 'member' = 'owner') {
  const server = new FakeServer();
  const state = { botMember: false, posts: [] as unknown[] };
  server.on('GET /api/me', () => ({ status: 200, body: { user: { id: ME, email: 'a@x', display_name: 'A', role }, csrf_token: 'csrf-1' } }));
  server.on('GET /api/members', () => ({
    status: 200,
    body: {
      members: [
        { id: ME, display_name: 'A', role: 'owner', kind: 'human' },
        { id: PEER, display_name: 'B', role: 'member', kind: 'human' },
        { id: BOT, display_name: 'Jarvis', role: 'member', kind: 'bot' },
      ],
    },
  }));
  server.on(`GET /api/conversations/${CONV}/messages`, () => ({
    status: 200,
    body: { messages: [message(1, { author_id: PEER, body: '안녕하세요' })], has_more: false },
  }));
  server.on(`GET /api/conversations/${CONV}/members`, () => ({
    status: 200,
    body: {
      members: [
        { id: ME, display_name: 'A' },
        { id: PEER, display_name: 'B' },
        ...(state.botMember ? [{ id: BOT, display_name: 'Jarvis' }] : []),
      ],
    },
  }));
  server.on(`POST /api/conversations/${CONV}/bots`, (_url, init) => {
    state.posts.push(JSON.parse(String(init?.body)));
    const created = !state.botMember;
    state.botMember = true;
    return { status: created ? 201 : 200, body: { conversation_id: CONV, bot_user_id: BOT } };
  });
  server.on(`DELETE /api/conversations/${CONV}/bots/${BOT}`, () => {
    state.botMember = false;
    return { status: 204 };
  });
  render(
    <LiveApp
      fetch={server.fetch}
      createSource={(deps) =>
        createHttpDataSource({
          ...deps,
          wsUrl: 'wss://oms.test/api/ws',
          createSocket: server.createSocket,
          storage: new MemoryStorage(),
          isOnline: () => true,
          setTimer: () => undefined,
          clearTimer: () => undefined,
          lifecycle: { doc: Object.assign(new EventTarget(), { visibilityState: 'visible' }), win: new EventTarget() },
        })
      }
    />,
  );
  return { server, state };
}

const nav = () => screen.getByRole('navigation', { name: '공간' });

function mentionOptions(): string[] {
  const box = screen.getByLabelText('#general에 메시지 작성') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: '@' } });
  const opts = screen.queryAllByRole('option').map((o) => o.textContent ?? '');
  fireEvent.change(box, { target: { value: '' } });
  return opts;
}

describe('LiveApp 사용자 시나리오(FR-BOT-11)', () => {
  it('owner: 채널 열기 → 봇 추가 → 멘션 후보에 봇 배지 → 제거 확인 → 후보에서 빠짐', async () => {
    const w = world();
    await settle();
    fireEvent.click(within(nav()).getByRole('button', { name: 'general' }));
    await settle();
    expect(screen.getByText('안녕하세요')).toBeTruthy();
    expect(screen.getByText('채널 · 멤버 2')).toBeTruthy();
    expect(mentionOptions()).toEqual(['B']);

    selectHeaderMenuItem(BOT_CHANNEL_COPY.add('Jarvis'));
    await settle();
    expect(w.state.posts).toEqual([{ bot_user_id: BOT }]);
    expect(screen.getByText('채널 · 멤버 3')).toBeTruthy();
    expect(mentionOptions()).toEqual(['B', `Jarvis ${BOT_BADGE_TEXT}`]);

    selectHeaderMenuItem(BOT_CHANNEL_COPY.title('Jarvis'));
    const dialog = screen.getByRole('dialog', { name: BOT_CHANNEL_COPY.title('Jarvis') });
    fireEvent.click(within(dialog).getByRole('button', { name: BOT_CHANNEL_COPY.confirm }));
    await settle();
    expect(w.server.log).toContain(`DELETE /api/conversations/${CONV}/bots/${BOT}`);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('채널 · 멤버 2')).toBeTruthy();
    expect(mentionOptions()).toEqual(['B']);
    expect(headerMenuItems()).toContain(BOT_CHANNEL_COPY.add('Jarvis'));
  });

  it('일반 멤버 계정에는 봇 컨트롤이 없다', async () => {
    const w = world('member');
    await settle();
    fireEvent.click(within(nav()).getByRole('button', { name: 'general' }));
    await settle();
    expect(screen.getByText('안녕하세요')).toBeTruthy();
    expect(headerMenuItems()).not.toContain(BOT_CHANNEL_COPY.add('Jarvis'));
    expect(w.server.log.some((l) => l.includes('/bots'))).toBe(false);
  });
});
