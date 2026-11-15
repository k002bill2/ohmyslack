import { useRef, useState } from 'react';
import type { ActionResult } from '../../data';
import { MessageMenu, type MessageMenuItem } from '../conversation';
import { LeaveChannelControl, type BotMenuItem } from '../conversation-membership';
import { HEADER_MENU_COPY } from '../../ui/copy.js';

function MenuButton({ items }: { readonly items: readonly MessageMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (items.length === 0) return null;
  return (
    <div className="header-menu">
      <button
        ref={trigger}
        type="button"
        className="icon-button"
        aria-label={HEADER_MENU_COPY.more}
        title={HEADER_MENU_COPY.more}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <g fill="currentColor">
            <circle cx="3.5" cy="8" r="1.2" />
            <circle cx="8" cy="8" r="1.2" />
            <circle cx="12.5" cy="8" r="1.2" />
          </g>
        </svg>
      </button>
      {open && <MessageMenu label={HEADER_MENU_COPY.menu} items={items} returnFocus={trigger} onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * R4 시안 대화 헤더 더보기(Floating-Menus D): (Jarvis DM) 알림 설정… · 키보드 단축키 · (구분선) 봇 추가·제거 · (구분선) 채널 나가기…(확인 Dialog는 LeaveChannelControl 그대로).
 * menu-bots-touch-focus: 봇 항목은 머리 버튼 줄 대신 여기(확인 Dialog·실패 표시는 `useBotChannelMenu`). 봇 0개면 항목·구분선 없음.
 * 나간 채널에서는 「다시 참여」 버튼이 헤더에 따로 남는다(UI_STATES §2-5).
 */
export function HeaderMenu({ onNotifications, onShortcuts, onLeave, bots = [] }: {
  /** Jarvis DM 알림 설정 Dialog 열기(G-74). */
  readonly onNotifications?: () => void;
  readonly onShortcuts?: () => void;
  readonly onLeave?: () => Promise<ActionResult<null>>;
  readonly bots?: readonly BotMenuItem[];
}) {
  const shortcuts: MessageMenuItem[] = [
    ...(onNotifications === undefined ? [] : [{ key: 'notifications', label: HEADER_MENU_COPY.notifications, onSelect: onNotifications }]),
    ...(onShortcuts === undefined ? [] : [{ key: 'shortcuts', label: HEADER_MENU_COPY.shortcuts, onSelect: onShortcuts }]),
  ];
  const head: MessageMenuItem[] = [...shortcuts, ...bots.map((b, i) => ({ ...b, separatorBefore: i === 0 && shortcuts.length > 0 }))];
  if (onLeave === undefined) return <MenuButton items={head} />;
  return (
    <LeaveChannelControl
      onLeave={onLeave}
      renderTrigger={(openLeave) => (
        <MenuButton
          items={[...head, { key: 'leave', label: HEADER_MENU_COPY.leave, danger: true, separatorBefore: head.length > 0, onSelect: openLeave }]}
        />
      )}
    />
  );
}
