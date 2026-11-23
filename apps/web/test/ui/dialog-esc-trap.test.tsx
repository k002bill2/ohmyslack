/**
 * dialog-esc-trap: 포커스가 BODY(배경 클릭·스크립트 blur 등)에 있어도 Dialog의 Tab·Shift+Tab·Esc가 동작한다
 * (WCAG 2.1.2·2.4.3, APG modal dialog). 가장 위 Dialog만 처리하고, 상자 안 키는 기존 `onKeyDown`이 한 번만 처리한다.
 * 참고 출처: 일반 관념.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
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

  it('중첩 — 같은 커밋에 연 부모·portal 자식 Dialog는 자식이 위(Codex r1 P2)', () => {
    const closed: string[] = [];
    function ParentChild() {
      const [child, setChild] = useState(true);
      return (
        <Dialog title="부모" onClose={() => closed.push('부모')}>
          <button type="button">부모 버튼</button>
          {child &&
            createPortal(
              <Dialog
                title="자식"
                onClose={() => {
                  closed.push('자식');
                  setChild(false);
                }}
              >
                <button type="button">자식 버튼</button>
              </Dialog>,
              document.body,
            )}
        </Dialog>
      );
    }
    render(<ParentChild />);
    (document.activeElement as HTMLElement).blur();
    const childDialog = screen.getByRole('dialog', { name: '자식' });
    expect(fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(within(childDialog).getByRole('button', { name: '닫기' }));
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(closed).toEqual(['자식']);
    expect(screen.queryByRole('dialog', { name: '자식' })).toBeNull();
    // 자식이 닫히면 부모가 다시 가장 위.
    (document.activeElement as HTMLElement).blur();
    const parentDialog = screen.getByRole('dialog', { name: '부모', hidden: true });
    expect(fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(within(parentDialog).getByRole('button', { name: '닫기' }));
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(closed).toEqual(['자식', '부모']);
  });

  it('중첩 — 부모·portal 자식이 열린 뒤 트리 다른 곳에서 나중에 연 최상위 Dialog가 위', () => {
    const closed: string[] = [];
    function Tree({ showS }: { readonly showS: boolean }) {
      const [child, setChild] = useState(true);
      const [s, setS] = useState(true);
      return (
        <>
          <Dialog title="부모" onClose={() => closed.push('부모')}>
            <button type="button">부모 버튼</button>
            {child &&
              createPortal(
                <Dialog
                  title="자식"
                  onClose={() => {
                    closed.push('자식');
                    setChild(false);
                  }}
                >
                  <button type="button">자식 버튼</button>
                </Dialog>,
                document.body,
              )}
          </Dialog>
          {showS && s && (
            <Dialog
              title="별도"
              onClose={() => {
                closed.push('별도');
                setS(false);
              }}
            >
              <button type="button">별도 버튼</button>
            </Dialog>
          )}
        </>
      );
    }
    const { rerender } = render(<Tree showS={false} />);
    rerender(<Tree showS />);
    const pressOnBody = (key: string) => {
      (document.activeElement as HTMLElement).blur();
      return fireEvent.keyDown(document.body, { key });
    };
    const firstOf = (name: string) => within(screen.getByRole('dialog', { name, hidden: true })).getByRole('button', { name: '닫기' });

    expect(pressOnBody('Tab')).toBe(false);
    expect(document.activeElement).toBe(firstOf('별도'));
    pressOnBody('Escape');
    expect(closed).toEqual(['별도']);
    expect(screen.queryByRole('dialog', { name: '별도', hidden: true })).toBeNull();
    // 별도가 닫히면 자식, 자식이 닫히면 부모가 가장 위.
    expect(pressOnBody('Tab')).toBe(false);
    expect(document.activeElement).toBe(firstOf('자식'));
    pressOnBody('Escape');
    expect(closed).toEqual(['별도', '자식']);
    expect(pressOnBody('Tab')).toBe(false);
    expect(document.activeElement).toBe(firstOf('부모'));
    pressOnBody('Escape');
    expect(closed).toEqual(['별도', '자식', '부모']);
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

describe('Dialog — 음수 tabindex 요소는 Tab 순환 끝점이 아니다(Codex P1-2, roving tabindex)', () => {
  function Roving() {
    return (
      <Dialog title="roving" onClose={() => undefined}>
        <button type="button" tabIndex={-1}>
          앞 비선택
        </button>
        <button type="button">선택</button>
        <button type="button" tabIndex={-1}>
          뒤 비선택
        </button>
      </Dialog>
    );
  }
  const button = (name: string) => within(screen.getByRole('dialog')).getByRole('button', { name });

  it('열릴 때 첫 포커스는 닫기(음수 tabindex 탭이 아님)', () => {
    render(<Roving />);
    expect(document.activeElement).toBe(button('닫기'));
  });

  it('닫기에서 Shift+Tab → 마지막 Tab 정지점(선택), 뒤 비선택 아님', () => {
    render(<Roving />);
    button('닫기').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(button('선택'));
  });

  it('선택(마지막 Tab 정지점)에서 Tab → 닫기로 순환', () => {
    render(<Roving />);
    button('선택').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(button('닫기'));
  });

  it('포커스가 BODY일 때 Shift+Tab → 마지막 Tab 정지점(선택)', () => {
    render(<Roving />);
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(button('선택'));
  });
});
