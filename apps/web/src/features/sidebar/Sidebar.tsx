import type { Account, ListState, Space } from '../../data';
import { COLLAPSED_LABEL_SEPARATOR, ERROR_COPY, MEMBER_ADMIN_COPY, SIDEBAR_COPY } from '../../ui/copy.js';
import { ErrorState } from '../../ui/ErrorState.js';
import { UnreadBadge, mentionLabel, threadDotLabel } from './UnreadBadge.js';

export interface SidebarProps {
  readonly spaces: readonly Space[];
  readonly selectedId: string | null;
  /** §5-2 접힘(72px): 이름은 `aria-label`·툴팁으로만. */
  readonly collapsed: boolean;
  readonly onSelect: (id: string) => void;
  /** 내 계정(하단 표시 이름 + 「로그아웃」). role = owner면 「채널 만들기」 진입점을 렌더한다. */
  readonly account?: Account;
  /** 목록 요청 상태(로딩 Skeleton·오류 ErrorState). 없으면 ready. */
  readonly listState?: ListState;
  /** 상단 「채널 찾기」(CMP-23). 없으면 버튼을 렌더하지 않는다. */
  readonly onBrowseChannels?: () => void;
  /** 상단 「DM 시작」(CMP-24). */
  readonly onStartDm?: () => void;
  /** owner 전용 「채널 만들기」 Dialog 열기. */
  readonly onCreateChannel?: () => void;
  /** 오류 상태 「다시 시도」. */
  readonly onRetryList?: () => void;
  /** owner 전용 하단 「멤버 관리」(`/settings/members`). role이 owner가 아니면 렌더하지 않는다. */
  readonly onManageMembers?: () => void;
  /** 하단 「로그아웃」. */
  readonly onLogout?: () => void;
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

/** 목록 본문: 로딩·오류·빈(관리자/비관리자)·기본(UI_STATES §2-3). */
function SpaceListBody(props: SidebarProps) {
  const { spaces, listState = 'ready', account } = props;
  if (listState === 'loading' && spaces.length === 0) return <div className="skeleton" aria-busy="true" />;
  if (listState === 'error' && spaces.length === 0) {
    return <ErrorState message={ERROR_COPY.network} {...(props.onRetryList ? { onRetry: props.onRetryList } : {})} />;
  }
  if (spaces.length === 0) {
    return <p className="empty-state">{account?.role === 'owner' ? SIDEBAR_COPY.emptyOwner : SIDEBAR_COPY.emptyMember}</p>;
  }
  return (
    <ul className="space-list">
      {spaces.map((space) => (
        <SpaceListItem
          key={space.id}
          space={space}
          selected={space.id === props.selectedId}
          collapsed={props.collapsed}
          onSelect={props.onSelect}
        />
      ))}
    </ul>
  );
}

/**
 * CMP-02 Sidebar · CMP-03 SpaceList — `nav aria-label="공간"`(디자인 §7-2).
 * 상단 「채널 찾기」·「DM 시작」(+ owner 「채널 만들기」), 하단 내 계정(표시 이름 + 「로그아웃」).
 * 하단 `.sidebar-account`에 owner 전용 「멤버 관리」 진입점(W-10h).
 */
export function Sidebar(props: SidebarProps) {
  const { collapsed, account } = props;
  return (
    <nav className="sidebar" aria-label="공간" data-collapsed={collapsed ? 'true' : 'false'}>
      <div className="sidebar-actions">
        {props.onBrowseChannels && (
          <button type="button" className="btn btn-secondary" onClick={props.onBrowseChannels}>
            {SIDEBAR_COPY.browseChannels}
          </button>
        )}
        {props.onStartDm && (
          <button type="button" className="btn btn-secondary" onClick={props.onStartDm}>
            {SIDEBAR_COPY.startDm}
          </button>
        )}
        {account?.role === 'owner' && props.onCreateChannel && (
          <button type="button" className="btn btn-secondary" onClick={props.onCreateChannel}>
            {SIDEBAR_COPY.createChannel}
          </button>
        )}
      </div>
      <SpaceListBody {...props} />
      {account !== undefined && (
        <div className="sidebar-account">
          {account.role === 'owner' && props.onManageMembers && (
            <button type="button" className="btn btn-secondary" onClick={props.onManageMembers}>
              {MEMBER_ADMIN_COPY.title}
            </button>
          )}
          <span className="account-name" title={account.displayName}>
            {account.displayName}
          </span>
          {props.onLogout && (
            <button type="button" className="btn btn-secondary" onClick={props.onLogout}>
              {SIDEBAR_COPY.logout}
            </button>
          )}
        </div>
      )}
    </nav>
  );
}
