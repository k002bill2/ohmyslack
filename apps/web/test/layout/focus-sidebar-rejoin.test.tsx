/**
 * focus-sidebar-rejoin: 포커스 유실 2건(WCAG 2.4.3).
 * 1) compact에서 사이드바 항목 선택 → 사이드바가 화면에서 사라지므로 F4 규칙(터치=대화 제목, 그 외=작성기)으로.
 *    wide는 사이드바가 남으므로 포커스를 사이드바에 둔다(기존).
 * 2) 나간 채널 「다시 참여」 → 같은 대화 ID여도 F4 규칙으로(버튼이 사라져 BODY가 되지 않게).
 * 참고 출처: 일반 관념.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource } from '../../src/data/http-source.js';
import { LEAVE_CHANNEL_COPY, LEFT_CHANNEL_COPY } from '../../src/ui/copy.js';
import { memory } from '../helpers/fixtures.js';
import { installViewport, setCoarsePointer } from '../helpers/viewport.js';
import { CONV, FakeServer, ME, MemoryStorage, PEER, flush, summary } from '../sync/fake-server.js';

afterEach(cleanup);

const nav = () => screen.getByRole('navigation', { name: '공간' });
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

function expectTitleFocus(name: string) {
  const active = document.activeElement as HTMLElement;
  expect(active).not.toBe(document.body);
  expect(active.tagName).toBe('H1');
  expect(active.className).toContain('conversation-title');
  expect(active.textContent).toContain(name);
}

describe('compact 사이드바 선택 뒤 포커스', () => {
  function renderAt(width: number, coarse: boolean) {
    installViewport(width);
    setCoarsePointer(coarse);
    render(<App dataSource={memory()} />);
  }

  it('compact·coarse: 대화 제목(h1.conversation-title)', () => {
    renderAt(390, true);
    fireEvent.click(within(nav()).getByRole('button', { name: 'general' }));
    expectTitleFocus('general');
  });

  it('compact·fine: 본문 작성기', () => {
    renderAt(390, false);
    fireEvent.click(within(nav()).getByRole('button', { name: 'general' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '#general에 메시지 작성' }));
  });

  it('compact: 뒤로 → 같은 공간 재선택도 BODY가 아니다', () => {
    renderAt(390, true);
    fireEvent.click(within(nav()).getByRole('button', { name: 'general' }));
    fireEvent.click(screen.getByRole('button', { name: '뒤로' }));
    fireEvent.click(within(nav()).getByRole('button', { name: 'general' }));
    expectTitleFocus('general');
  });

  it('wide: 포커스는 사이드바 항목에 남는다(기존)', () => {
    renderAt(1280, false);
    const item = within(nav()).getByRole('button', { name: 'general' });
    item.focus();
    fireEvent.click(item);
    expect(document.activeElement).toBe(within(nav()).getByRole('button', { name: 'general' }));
  });
});

describe('「다시 참여」 뒤 포커스', () => {
  function world() {
    const server = new FakeServer();
    const state = { left: false };
    server.on('GET /api/conversations', () => ({
      status: 200,
      body: { conversations: state.left ? [] : [summary()], next_cursor: null },
    }));
    server.on(`GET /api/conversations/${CONV}/members`, () => ({
      status: 200,
      body: { members: [{ id: ME, display_name: 'A' }, { id: PEER, display_name: 'B' }] },
    }));
    server.on(`DELETE /api/conversations/${CONV}/membership`, () => {
      state.left = true;
      return { status: 204 };
    });
    server.on(`POST /api/conversations/${CONV}/join`, () => {
      state.left = false;
      return { status: 200, body: { id: CONV } };
    });
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
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
            lifecycle: { doc, win: new EventTarget() },
          })
        }
      />,
    );
  }

  async function leaveThenRejoin(coarse: boolean) {
    installViewport(1280);
    setCoarsePointer(coarse);
    world();
    await settle();
    fireEvent.click(within(nav()).getByRole('button', { name: 'general' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '대화 더보기' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '채널 나가기…' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: LEAVE_CHANNEL_COPY.confirm }));
    await settle();
    const rejoin = screen.getByRole('button', { name: LEFT_CHANNEL_COPY.rejoin });
    rejoin.focus();
    fireEvent.click(rejoin);
    await settle();
  }

  it('coarse: 대화 제목, BODY 아님', async () => {
    await leaveThenRejoin(true);
    expectTitleFocus('general');
  });

  it('fine: 다시 나타난 본문 작성기', async () => {
    await leaveThenRejoin(false);
    expect(document.activeElement).toBe(screen.getByLabelText('#general에 메시지 작성'));
  });
});
