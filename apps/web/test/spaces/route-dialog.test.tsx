/** W-10g: 경로 상태(`/c/:id` 복원·push·popstate)와 CMP-18 Dialog(트랩·Esc·IME Esc 무시·포커스 복귀·스크롤 잠금). */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, formatRoute, parseRoute } from '../../src/app/route.js';
import { AppShell } from '../../src/features/layout';
import { Dialog } from '../../src/ui/Dialog.js';
import { memory } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

afterEach(cleanup);

describe('route', () => {
  it.each([
    ['/', { kind: 'root' }],
    ['/c/abc', { kind: 'conversation', conversationId: 'abc' }],
    ['/c/abc/', { kind: 'conversation', conversationId: 'abc' }],
    ['/login', { kind: 'login' }],
    ['/invite', { kind: 'invite' }],
    ['/settings/members', { kind: 'members' }],
    ['/discover', { kind: 'discover' }],
    ['/dm/new', { kind: 'dm-new' }],
    ['/nope', { kind: 'root' }],
    ['/c/%E0%A4%A', { kind: 'root' }],
  ])('parseRoute(%s)', (path, route) => {
    expect(parseRoute(path)).toEqual(route);
  });

  it('formatRoute ↔ parseRoute 왕복', () => {
    for (const p of ['/', '/c/a%20b', '/login', '/invite', '/settings/members', '/discover', '/dm/new']) {
      expect(formatRoute(parseRoute(p))).toBe(p);
    }
  });

  it('memory history: push·replace·back(popstate 알림)', () => {
    const h = createMemoryHistory('/');
    const pop = vi.fn();
    const off = h.listen(pop);
    h.push('/c/1');
    h.replace('/c/2');
    expect(h.entries()).toEqual(['/', '/c/2']);
    h.back();
    expect(h.pathname()).toBe('/');
    expect(pop).toHaveBeenCalledTimes(1);
    h.back();
    expect(pop).toHaveBeenCalledTimes(1);
    off();
  });

  it('AppShell: 새로고침 `/c/:id` 복원, 선택 → push, 뒤로가기 → 이전 선택', () => {
    installViewport(1280);
    const history = createMemoryHistory('/c/c2');
    render(<AppShell dataSource={memory()} history={history} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('#dev');
    fireEvent.click(screen.getByRole('button', { name: 'general' }));
    expect(history.entries()).toEqual(['/c/c2', '/c/c1']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('#general');
    act(() => history.back());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('#dev');
  });

  it('AppShell: 첫 진입 경로가 대화가 아니면 `/`로 replace(히스토리 늘리지 않음)', () => {
    installViewport(1280);
    const history = createMemoryHistory('/login');
    render(<AppShell dataSource={memory()} history={history} />);
    expect(history.entries()).toEqual(['/']);
  });
});

function Harness({ onClose }: { readonly onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        열기
      </button>
      {open && (
        <Dialog
          title="채널 만들기"
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        >
          <input aria-label="a" />
          <button type="button">b</button>
        </Dialog>
      )}
    </>
  );
}

describe('CMP-18 Dialog', () => {
  it('role=dialog·aria-modal·제목 연결, 첫 입력에 포커스, body 스크롤 잠금', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '열기' }));
    const dialog = screen.getByRole('dialog', { name: '채널 만들기' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('a'));
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('Tab 트랩: 마지막 → 첫, Shift+Tab 첫 → 마지막', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '열기' }));
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: '닫기' });
    const last = screen.getByRole('button', { name: 'b' });
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('Esc → 닫힘, 트리거로 포커스 복귀, 스크롤 잠금 해제', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: '열기' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe('');
  });

  it('닫기 버튼 → 닫힘 + 트리거 복귀', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: '열기' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('IME 조합 중 Esc(isComposing·keyCode 229)는 무시', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '열기' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(dialog, { key: 'Escape', keyCode: 229 });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
