/**
 * QA D2·D3: 비활성 이름은 이름 span + 접미 span(「(비활성)」 한 덩어리)으로 그린다.
 * - D2 작성자 줄: 접미가 「(비 / 활성)」로 중간에서 끊기지 않게 `.name-suffix`(white-space: nowrap).
 * - D3 사이드바 DM 이름·대화 머리 H1: 이름만 말줄임(`.name-split`), 접미는 항상 보이고 전체 이름은 title.
 * 접근 이름(aria-label·텍스트 이어 읽기)은 「{이름} (비활성)」 그대로. 레이아웃 측정은 jsdom 한계라 클래스·속성으로 보고, CSS 규칙은 test/ui/name-split-css.test.ts.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource } from '../../src/data/http-source.js';
import { CONV, FakeServer, ME, MemoryStorage, U, flush, message, setup, summary } from './fake-server.js';

afterEach(cleanup);

const GONE = U(3);
const DM = U(11);
const LABEL = '떠난이 (비활성)';
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

function world() {
  const server = new FakeServer();
  server.on('GET /api/conversations', () => ({
    status: 200,
    body: { conversations: [summary(), summary({ id: DM, kind: 'dm', name: null, peer_user_id: GONE })], next_cursor: null },
  }));
  server.on(`GET /api/conversations/${DM}/messages`, () => ({
    status: 200,
    body: { messages: [message(1, { conversation_id: DM, author_id: GONE, body: '예전 글' }), message(2, { conversation_id: DM, author_id: ME, body: '내 글' })], has_more: false },
  }));
  server.on(`GET /api/conversations/${DM}/members`, () => ({ status: 200, body: { members: [{ id: ME, display_name: 'A' }] } }));
  server.on('GET /api/users/names', () => ({ status: 200, body: { users: [{ id: GONE, display_name: '떠난이', status: 'disabled', kind: 'human' }] } }));
  render(
    <LiveApp
      fetch={(input, init) => server.fetch(String(input), init)}
      createSource={(deps) =>
        createHttpDataSource({
          ...deps,
          wsUrl: 'wss://oms.test/api/ws',
          createSocket: server.createSocket,
          storage: new MemoryStorage(),
          isOnline: () => true,
          setTimer: () => 0,
          clearTimer: () => undefined,
        })
      }
    />,
  );
  return server;
}

const parts = (el: Element | null) => ({
  base: el?.querySelector('.name-base')?.textContent,
  suffix: el?.querySelector('.name-suffix')?.textContent,
  text: el?.textContent,
});

describe('QA D2·D3 — 비활성 이름 이름·접미 분리', () => {
  it('데이터: 접미 없는 이름을 따로 싣는다(작성자·DM 상대), 표시 문자열은 그대로', async () => {
    const { server, ds } = setup();
    server.on('GET /api/conversations', () => ({
      status: 200,
      body: { conversations: [summary(), summary({ id: DM, kind: 'dm', name: null, peer_user_id: GONE })], next_cursor: null },
    }));
    server.on(`GET /api/conversations/${CONV}/messages`, () => ({ status: 200, body: { messages: [message(1, { author_id: GONE })], has_more: false } }));
    server.on('GET /api/users/names', () => ({ status: 200, body: { users: [{ id: GONE, display_name: '떠난이', status: 'disabled', kind: 'human' }] } }));
    await ds.start();
    ds.open?.(CONV);
    for (let i = 0; i < 10; i += 1) await flush();
    const dm = ds.getSnapshot().spaces.find((s) => s.id === DM);
    expect(dm?.name).toBe(LABEL);
    expect(dm?.peerInactiveName).toBe('떠난이');
    const m = ds.getSnapshot().messages[0];
    expect(m?.author).toBe(LABEL);
    expect(m?.authorInactiveName).toBe('떠난이');
    // 활성 채널·활성 작성자에는 키가 없다.
    expect(ds.getSnapshot().spaces.find((s) => s.id === CONV)).not.toHaveProperty('peerInactiveName');
  });

  it('LiveApp: 사이드바 DM·대화 머리·작성자 줄 — 접미 span 분리, title, 접근 이름 불변', async () => {
    world();
    await settle();
    const nav = screen.getByRole('navigation', { name: '공간' });
    // 접근 이름(텍스트 이어 읽기)은 그대로 「떠난이 (비활성)」.
    const dmButton = within(nav).getByRole('button', { name: LABEL });
    const sideName = dmButton.querySelector('.space-name');
    expect(sideName?.classList.contains('name-split')).toBe(true);
    expect(sideName?.getAttribute('title')).toBe(LABEL);
    expect(parts(sideName)).toEqual({ base: '떠난이', suffix: '(비활성)', text: LABEL });
    // 활성 채널 이름은 지금 그대로(분리·title 없음).
    const general = within(nav).getByRole('button', { name: 'general' }).querySelector('.space-name');
    expect(general?.classList.contains('name-split')).toBe(false);
    expect(general?.hasAttribute('title')).toBe(false);
    expect(general?.querySelector('.name-suffix')).toBeNull();

    fireEvent.click(dmButton);
    await settle();
    const h1 = screen.getByRole('heading', { level: 1, name: LABEL });
    expect(h1.classList.contains('name-split')).toBe(true);
    expect(h1.getAttribute('title')).toBe(LABEL);
    expect(parts(h1)).toEqual({ base: '떠난이', suffix: '(비활성)', text: LABEL });

    const item = document.querySelector(`[aria-label^="${LABEL}, "]`);
    expect(item).not.toBeNull();
    const author = item?.querySelector('.msg-author') ?? null;
    expect(parts(author)).toEqual({ base: '떠난이', suffix: '(비활성)', text: LABEL });
    // 활성 작성자 줄은 분리하지 않는다.
    const mine = document.querySelector('[aria-label^="A, "] .msg-author');
    expect(mine?.textContent).toBe('A');
    expect(mine?.querySelector('.name-suffix')).toBeNull();
  });

});
