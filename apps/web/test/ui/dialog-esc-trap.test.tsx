/**
 * dialog-esc-trap: 포커스가 BODY(배경 클릭·스크립트 blur 등)에 있어도 Dialog의 Tab·Shift+Tab·Esc가 동작한다
 * (WCAG 2.1.2·2.4.3, APG modal dialog). 가장 위 Dialog만 처리하고, 상자 안 키는 기존 `onKeyDown`이 한 번만 처리한다.
 * 참고 출처: 일반 관념.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Dialog } from '../../src/ui/Dialog.js';

afterEach(cleanup);

function Host({ nested = false }: { readonly nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const [inner, setInner] = useState(nested);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        열기
      </button>
      {open && (
        <Dialog title="바깥" onClose={() => setOpen(false)}>
          <button type="button">첫째</button>
          <button type="button">끝</button>
        </Dialog>
      )}
      {open && inner && (
        <Dialog title="안쪽" onClose={() => setInner(false)}>
          <button type="button">안쪽 버튼</button>
        </Dialog>
      )}
    </>
  );
}

/** 트리거로 열고 상자 안 포커스를 blur해 BODY로 보낸다. */
function openThenBlur(nested = false) {
  render(<Host nested={nested} />);
  const trigger = screen.getByRole('button', { name: '열기' });
  trigger.focus();
  fireEvent.click(trigger);
  (document.activeElement as HTMLElement).blur();
  expect(document.activeElement).toBe(document.body);
  return trigger;
}

const outer = () => screen.getByRole('dialog', { name: '바깥', hidden: true });

describe('Dialog — 포커스가 BODY일 때도 트랩', () => {
  it('Tab → 첫 항목(닫기)', () => {
    openThenBlur();
    expect(fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(within(outer()).getByRole('button', { name: '닫기' }));
  });

  it('Shift+Tab → 마지막 항목', () => {
    openThenBlur();
    expect(fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(within(outer()).getByRole('button', { name: '끝' }));
  });

  it('Esc → 닫힘·트리거 복귀', () => {
    const trigger = openThenBlur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('IME 조합 중 Esc는 닫지 않는다', () => {
    openThenBlur();
    fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(document.body, { key: 'Escape', keyCode: 229 });
    expect(outer()).toBeTruthy();
  });

  it('배경(inert 처리된 형제)에 남은 포커스에서도 Tab이 상자로', () => {
    render(<Host />);
    const trigger = screen.getByRole('button', { name: '열기' });
    fireEvent.click(trigger);
    trigger.focus(); // jsdom은 inert 포커스를 막지 않는다 — 배경에 남은 포커스를 흉내 낸다.
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(within(outer()).getByRole('button', { name: '닫기' }));
  });

  it('다른 레이어(상자·배경 밖, 나중에 붙은 요소)의 키는 가로채지 않는다', () => {
    openThenBlur();
    const layer = document.createElement('button');
    document.body.append(layer);
    try {
      layer.focus();
      expect(fireEvent.keyDown(layer, { key: 'Tab' })).toBe(true);
      fireEvent.keyDown(layer, { key: 'Escape' });
      expect(outer()).toBeTruthy();
      expect(document.activeElement).toBe(layer);
    } finally {
      layer.remove();
    }
  });

  it('중첩 — 가장 위(나중에 열린) Dialog만 처리한다', () => {
    openThenBlur(true);
    expect(fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(false);
    const innerDialog = screen.getByRole('dialog', { name: '안쪽' });
    expect(innerDialog.contains(document.activeElement)).toBe(true);
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '안쪽' })).toBeNull();
    expect(outer()).toBeTruthy();
  });

  it('상자 안 Tab은 기존 onKeyDown이 한 번만 처리(끝 → 닫기)', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: '열기' }));
    const tail = within(outer()).getByRole('button', { name: '끝' });
    tail.focus();
    expect(fireEvent.keyDown(tail, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(within(outer()).getByRole('button', { name: '닫기' }));
  });
});
