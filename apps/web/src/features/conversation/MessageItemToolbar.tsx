import { useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { MESSAGE_ACTION_COPY, MESSAGE_MENU_COPY } from '../../ui/copy.js';
import { MessageMenu, type MessageMenuItem } from './MessageMenu.js';

/** 툴바·메뉴가 고를 수 있는 동작. 판정(본인·삭제·전송 상태)은 MessageItem이 한다. */
export interface MessageToolbarCaps {
  readonly reply: boolean;
  readonly edit: boolean;
  readonly delete: boolean;
  /** 메뉴(텍스트 복사 등)를 열 수 있는가 — 삭제 자리표시자·전송 대기·편집 중이면 false. */
  readonly menu: boolean;
}

export interface MessageToolbarActions {
  readonly onReply: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onCopyText: () => void;
  /** 없으면 「메시지 링크 복사」를 렌더하지 않는다(링크를 만들 대화 주소가 없는 곳). */
  readonly onCopyLink?: () => void;
}

type MenuState = { readonly at?: { readonly x: number; readonly y: number } } | null;

/**
 * 메시지 메뉴 열기 상태 + 항목 쪽 진입점(우클릭·Shift+F10·ContextMenu 키).
 * `returnTo`는 메뉴가 닫힐 때 포커스를 받을 요소 — 더보기 버튼으로 열면 그 버튼, 항목에서 열면 항목.
 */
export function useMessageMenu(item: RefObject<HTMLElement | null>, enabled: boolean) {
  const [menu, setMenu] = useState<MenuState>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const openFromItem = (at: { readonly x: number; readonly y: number }) => {
    returnTo.current = item.current;
    setMenu({ at });
  };
  const onContextMenu = (e: MouseEvent<HTMLElement>) => {
    if (!enabled) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    openFromItem({ x: Math.max(0, e.clientX - rect.left), y: Math.max(0, e.clientY - rect.top) });
  };
  /** 항목 자체에 포커스가 있을 때 Shift+F10·ContextMenu 키 → 메뉴(키보드 경로). 처리했으면 true. */
  const onItemKey = (e: KeyboardEvent<HTMLElement>): boolean => {
    if (!enabled || e.target !== e.currentTarget) return false;
    if (!((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu')) return false;
    e.preventDefault();
    openFromItem({ x: 16, y: 8 });
    return true;
  };
  return { menu, setMenu, returnTo, onContextMenu, onItemKey };
}

function ReplyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M6 11 2.5 7.5 6 4M13.5 12v-1.5a3 3 0 0 0-3-3h-8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M11.2 2.3a1.4 1.4 0 0 1 2 2L4.8 12.7l-2.6.8.8-2.6z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EllipsisIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <g fill="currentColor">
        <circle cx="3.5" cy="8" r="1.2" />
        <circle cx="8" cy="8" r="1.2" />
        <circle cx="12.5" cy="8" r="1.2" />
      </g>
    </svg>
  );
}

/**
 * R4 시안 메시지 툴바(Floating-Menus A·B): 대표 동작 「답글」은 글자와 함께, 수정·더보기는 아이콘만.
 * 「더보기」 메뉴 = 스레드로 답글(R) · 텍스트 복사 · 메시지 링크 복사 · ─ · 메시지 수정(E) · 메시지 삭제…(Del).
 */
export function MessageItemToolbar(props: {
  readonly messageId: string;
  readonly caps: MessageToolbarCaps;
  readonly actions: MessageToolbarActions;
  readonly menu: ReturnType<typeof useMessageMenu>;
}) {
  const { caps, actions, menu } = props;
  const more = useRef<HTMLButtonElement>(null);
  const items: MessageMenuItem[] = [
    ...(caps.reply ? [{ key: 'reply', label: MESSAGE_MENU_COPY.replyInThread, shortcut: 'R', onSelect: actions.onReply }] : []),
    { key: 'copy-text', label: MESSAGE_MENU_COPY.copyText, onSelect: actions.onCopyText },
    ...(actions.onCopyLink === undefined ? [] : [{ key: 'copy-link', label: MESSAGE_MENU_COPY.copyLink, onSelect: actions.onCopyLink }]),
    ...(caps.edit ? [{ key: 'edit', label: MESSAGE_MENU_COPY.edit, shortcut: 'E', separatorBefore: true, onSelect: actions.onEdit }] : []),
    ...(caps.delete
      ? [{ key: 'delete', label: MESSAGE_MENU_COPY.delete, shortcut: 'Del', danger: true, separatorBefore: !caps.edit, onSelect: actions.onDelete }]
      : []),
  ];
  const open = menu.menu !== null;
  return (
    <>
      {(caps.reply || caps.edit || caps.menu) && (
        <div className="msg-toolbar" role="toolbar" aria-label={MESSAGE_MENU_COPY.menu} data-open={open ? 'true' : undefined}>
          {caps.reply && (
            <button type="button" className="msg-action msg-action-reply" data-reply-for={props.messageId} title={`${MESSAGE_MENU_COPY.reply} (R)`} onClick={actions.onReply}>
              <ReplyIcon />
              {MESSAGE_MENU_COPY.reply}
            </button>
          )}
          {caps.edit && (
            <button type="button" className="msg-action msg-action-icon" aria-label={MESSAGE_ACTION_COPY.edit} title={`${MESSAGE_ACTION_COPY.edit} (E)`} onClick={actions.onEdit}>
              <PencilIcon />
            </button>
          )}
          {caps.menu && (
            <button
              ref={more}
              type="button"
              className="msg-action msg-action-icon"
              aria-label={MESSAGE_MENU_COPY.more}
              title={`${MESSAGE_MENU_COPY.more} (Shift+F10)`}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => {
                menu.returnTo.current = more.current;
                menu.setMenu(open ? null : {});
              }}
            >
              <EllipsisIcon />
            </button>
          )}
        </div>
      )}
      {open && caps.menu && (
        <MessageMenu
          label={MESSAGE_MENU_COPY.menu}
          items={items}
          {...(menu.menu?.at === undefined ? {} : { at: menu.menu.at })}
          returnFocus={menu.returnTo}
          onClose={() => menu.setMenu(null)}
        />
      )}
    </>
  );
}
