import { useRef, useState } from 'react';
import type { ActionResult } from '../../data';
import { MessageMenu, type MessageMenuItem } from '../conversation';
import { LeaveChannelControl } from '../conversation-membership';
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
 * R4 시안 대화 헤더 더보기(Floating-Menus D): 키보드 단축키 · 채널 나가기…(확인 Dialog는 LeaveChannelControl 그대로).
 * 나간 채널에서는 「다시 참여」 버튼이 헤더에 따로 남는다(UI_STATES §2-5).
 */
export function HeaderMenu({ onShortcuts, onLeave }: {
  readonly onShortcuts?: () => void;
  readonly onLeave?: () => Promise<ActionResult<null>>;
}) {
  const shortcuts: MessageMenuItem[] = onShortcuts === undefined ? [] : [{ key: 'shortcuts', label: HEADER_MENU_COPY.shortcuts, onSelect: onShortcuts }];
  if (onLeave === undefined) return <MenuButton items={shortcuts} />;
  return (
    <LeaveChannelControl
      onLeave={onLeave}
      renderTrigger={(openLeave) => (
        <MenuButton
          items={[...shortcuts, { key: 'leave', label: HEADER_MENU_COPY.leave, danger: true, separatorBefore: shortcuts.length > 0, onSelect: openLeave }]}
        />
      )}
    />
  );
}
