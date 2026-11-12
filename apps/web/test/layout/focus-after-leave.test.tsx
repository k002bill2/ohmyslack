/**
 * focus-after-leave: 「채널 나가기」 확인 Dialog에서 「나가기」 성공 직후 포커스가 BODY로 빠지지 않게(WCAG 2.4.3).
 * 나간 화면의 다음 행동인 머리 「다시 참여」 버튼으로 — 버튼이라 터치(coarse)에서도 가상 키보드가 뜨지 않는다.
 * 취소·Escape는 「대화 더보기」 트리거로 복귀(기존), 실패는 Dialog 유지·오류 표시(기존).
 * 참고 출처: 일반 관념.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource } from '../../src/data/http-source.js';
import { LEAVE_CHANNEL_COPY, LEFT_CHANNEL_COPY } from '../../src/ui/copy.js';
import { installViewport, setCoarsePointer } from '../helpers/viewport.js';
import { CONV, FakeServer, ME, MemoryStorage, PEER, flush, summary } from '../sync/fake-server.js';

afterEach(cleanup);

const nav = () => screen.getByRole('navigation', { name: '공간' });
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

function world(leaveStatus: 204 | 500 = 204) {
  // 앞 테스트가 남긴 대화 주소(/c/…)에서 시작하면 compact는 사이드바 대신 대화가 보인다.
  window.history.replaceState(null, '', '/');
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
    if (leaveStatus !== 204) return { status: leaveStatus, body: { error: 'internal' } };
    state.left = true;
    return { status: 204 };
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

async function openLeaveDialog(width: number, coarse: boolean, leaveStatus: 204 | 500 = 204) {
  installViewport(width);
  setCoarsePointer(coarse);
  world(leaveStatus);
  await settle();
  fireEvent.click(within(nav()).getByRole('button', { name: 'general' }));
  await settle();
  const more = screen.getByRole('button', { name: '대화 더보기' });
  more.focus();
  fireEvent.click(more);
  fireEvent.click(screen.getByRole('menuitem', { name: '채널 나가기…' }));
  return { dialog: screen.getByRole('dialog'), more };
}

async function confirmLeave(width: number, coarse: boolean) {
  const { dialog } = await openLeaveDialog(width, coarse);
  fireEvent.click(within(dialog).getByRole('button', { name: LEAVE_CHANNEL_COPY.confirm }));
  await settle();
}

describe('「나가기」 성공 뒤 포커스 = 머리 「다시 참여」', () => {
  it.each([
    [390, true],
    [390, false],
    [1280, true],
    [1280, false],
  ])('%ipx · coarse=%s', async (width, coarse) => {
    await confirmLeave(width, coarse);
    expect(screen.queryByRole('dialog')).toBeNull();
    const active = document.activeElement;
    expect(active).not.toBe(document.body);
    expect(active).toBe(screen.getByRole('button', { name: LEFT_CHANNEL_COPY.rejoin }));
    expect(active?.tagName).not.toBe('TEXTAREA');
  });

  it('사용자가 이미 옮긴 포커스(사이드바)는 빼앗지 않는다', async () => {
    installViewport(1280);
    setCoarsePointer(false);
    world();
    await settle();
    fireEvent.click(within(nav()).getByRole('button', { name: 'general' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '대화 더보기' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '채널 나가기…' }));
    // 응답 전에 Dialog 밖(사이드바)으로 포커스가 옮겨진 상황 — 확인 클릭 직후 동기적으로 옮긴다.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: LEAVE_CHANNEL_COPY.confirm }));
    const elsewhere = within(nav()).getByRole('button', { name: 'general' });
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);
    await settle();
    expect(screen.getByRole('button', { name: LEFT_CHANNEL_COPY.rejoin })).toBeTruthy();
    expect(document.activeElement).toBe(within(nav()).getByRole('button', { name: 'general' }));
  });
});

describe('취소·Escape·실패(기존 동작 고정)', () => {
  it.each([390, 1280])('%ipx 취소 → 「대화 더보기」로 복귀', async (width) => {
    const { dialog, more } = await openLeaveDialog(width, false);
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it.each([390, 1280])('%ipx Escape → 「대화 더보기」로 복귀', async (width) => {
    const { dialog, more } = await openLeaveDialog(width, true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('실패 → Dialog 유지·오류 표시, 「다시 참여」 없음', async () => {
    const { dialog } = await openLeaveDialog(1280, false, 500);
    fireEvent.click(within(dialog).getByRole('button', { name: LEAVE_CHANNEL_COPY.confirm }));
    await settle();
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: LEFT_CHANNEL_COPY.rejoin })).toBeNull();
  });
});
