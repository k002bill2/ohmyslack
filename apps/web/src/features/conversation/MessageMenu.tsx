import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

export interface MessageMenuItem {
  readonly key: string;
  readonly label: string;
  /** 오른쪽 단축키 표기(R·E·Del). 장식 — 접근 이름은 label만. */
  readonly shortcut?: string;
  readonly danger?: boolean;
  /** 이 항목 위에 구분선. */
  readonly separatorBefore?: boolean;
  readonly onSelect: () => void;
}

export interface MessageMenuProps {
  readonly label: string;
  readonly items: readonly MessageMenuItem[];
  /** 항목 기준 위치(px). 없으면 툴바 아래 오른쪽 정렬(CSS 기본 위치). */
  readonly at?: { readonly x: number; readonly y: number };
  /** 닫힐 때 포커스를 돌려줄 요소(더보기 버튼 또는 메시지 항목 — Floating-Menus B 「메뉴를 닫으면 포커스가 더보기 버튼으로」). */
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}

/**
 * R4 시안 메시지 메뉴(Floating-Menus B): APG menu — 열리면 첫 항목에 포커스, ↑↓·Home·End 이동(순환),
 * Enter·Space 선택, Esc·Tab·바깥 누르기로 닫기. 닫으면(선택 포함) 포커스를 `returnFocus`로 먼저 돌려준 뒤
 * 동작을 실행한다 — 삭제 확인 Dialog가 그 요소를 복귀 대상으로 잡는다.
 */
export function MessageMenu({ label, items, at, returnFocus, onClose }: MessageMenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const buttons = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);

  // 위치는 CSSOM 사용자 속성으로(CSP style-src 'self' — 마크업 style 속성을 쓰지 않는다).
  useLayoutEffect(() => {
    const el = menu.current;
    if (el === null || at === undefined) return;
    el.style.setProperty('--msg-menu-x', `${at.x}px`);
    el.style.setProperty('--msg-menu-y', `${at.y}px`);
    el.dataset['at'] = 'pointer';
  }, [at]);

  // 스크롤 영역(목록·스레드) 아래로 넘치면 위로 펼친다 — 마지막 메시지 메뉴가 잘리지 않게.
  useLayoutEffect(() => {
    const el = menu.current;
    const scroller = el?.closest('.message-list, .thread-panel');
    if (el === null || scroller === null || scroller === undefined) return;
    if (el.getBoundingClientRect().bottom > scroller.getBoundingClientRect().bottom) el.dataset['flip'] = 'up';
  }, []);

  // onClose는 렌더마다 새 함수일 수 있다 — 열릴 때 한 번만 포커스·리스너를 걸고 최신 콜백은 ref로 읽는다.
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => {
    buttons()[0]?.focus();
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      // 트리거(더보기 버튼) 누르기는 그 버튼의 토글이 처리한다 — 여기서 닫으면 바로 다시 열린다.
      if (menu.current?.contains(target) === true || returnFocus.current?.contains(target) === true) return;
      latestClose.current();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, []);

  const close = () => {
    returnFocus.current?.focus();
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = buttons();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => {
      e.preventDefault();
      list[(next + list.length) % list.length]?.focus();
    };
    if (e.key === 'ArrowDown') move(index + 1);
    else if (e.key === 'ArrowUp') move(index - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(list.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    // 메시지 항목의 R·E·Delete 단축키로 새지 않게.
    e.stopPropagation();
  };

  return (
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      className="msg-menu"
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <div key={item.key} role="none" className="msg-menu-row">
          {item.separatorBefore === true && <div role="separator" className="msg-menu-separator" />}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={item.danger === true ? 'msg-menu-item msg-menu-danger' : 'msg-menu-item'}
            onClick={() => {
              close();
              item.onSelect();
            }}
          >
            <span className="msg-menu-label">{item.label}</span>
            {item.shortcut !== undefined && (
              <kbd className="msg-menu-key" aria-hidden="true">
                {item.shortcut}
              </kbd>
            )}
          </button>
        </div>
      ))}
    </div>
  );
}
