import type { Space } from '../../data';
import { COLLAPSED_LABEL_SEPARATOR } from '../../ui/copy.js';
import { UnreadBadge, mentionLabel, threadDotLabel } from './UnreadBadge.js';

export interface SidebarProps {
  readonly spaces: readonly Space[];
  readonly selectedId: string | null;
  /** §5-2 접힘(72px): 이름은 `aria-label`·툴팁으로만. */
  readonly collapsed: boolean;
  readonly onSelect: (id: string) => void;
}

/** 접힘 상태 항목 이름: 이름 + 상태(디자인 §7-2 "접힘 상태는 각 항목 aria-label에 이름+상태 포함"). */
function collapsedLabel(space: Space): string {
  const parts = [space.name];
  if (space.mentionCount > 0) parts.push(mentionLabel(space.mentionCount));
  if (space.unreadThreadCount > 0) parts.push(threadDotLabel(space.unreadThreadCount));
  return parts.join(COLLAPSED_LABEL_SEPARATOR);
}

/** CMP-03 SpaceListItem — 굵게(unread)·배지(멘션)·점(새 답글) 세 표시는 독립(UI_STATES §2-3). */
function SpaceListItem({ space, selected, collapsed, onSelect }: {
  readonly space: Space;
  readonly selected: boolean;
  readonly collapsed: boolean;
  readonly onSelect: (id: string) => void;
}) {
  const classes = ['space-item', selected ? 'space-selected' : '', space.unreadCount > 0 ? 'space-unread' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <li>
      <button
        type="button"
        className={classes}
        data-space-id={space.id}
        aria-current={selected ? 'page' : undefined}
        aria-label={collapsed ? collapsedLabel(space) : undefined}
        title={collapsed ? space.name : undefined}
        onClick={() => onSelect(space.id)}
      >
        <span className={collapsed ? 'visually-hidden' : 'space-name'}>{space.name}</span>
        {space.unreadThreadCount > 0 && (
          <span className="thread-dot" role="img" aria-label={threadDotLabel(space.unreadThreadCount)} />
        )}
        <UnreadBadge count={space.mentionCount} />
      </button>
    </li>
  );
}

/** CMP-02 Sidebar · CMP-03 SpaceList — `nav aria-label="공간"` > `ul`(디자인 §7-2). */
export function Sidebar({ spaces, selectedId, collapsed, onSelect }: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="공간" data-collapsed={collapsed ? 'true' : 'false'}>
      <ul className="space-list">
        {spaces.map((space) => (
          <SpaceListItem
            key={space.id}
            space={space}
            selected={space.id === selectedId}
            collapsed={collapsed}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </nav>
  );
}
