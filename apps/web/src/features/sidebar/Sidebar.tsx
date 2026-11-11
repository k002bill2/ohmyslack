import { useId, type ReactNode } from 'react';
import type { Account, ListState, Space } from '../../data';
import { BotBadge, withBotLabel } from '../../ui/BotBadge.js';
import { isSplitName, NameParts } from '../../ui/NameParts.js';
import { APP_NAME, COLLAPSED_LABEL_SEPARATOR, ERROR_COPY, LEFT_CHANNEL_COPY, MEMBER_ADMIN_COPY, SIDEBAR_COPY } from '../../ui/copy.js';
import { ErrorState } from '../../ui/ErrorState.js';
import { SIDEBAR_SHELL_COPY } from './copy.js';
import { AppMark, HashIcon, LogOutIcon, MessageSquareIcon, PanelLeftIcon, PlusIcon, SearchIcon, UsersIcon } from './icons.js';
import { UnreadBadge, mentionLabel, threadDotLabel } from './UnreadBadge.js';

export interface SidebarProps {
  readonly spaces: readonly Space[];
  readonly selectedId: string | null;
  /** §5-2 접힘(72px): 이름은 `aria-label`·툴팁으로만. */
  readonly collapsed: boolean;
  /** compact(≤640) 전체 화면 공간 목록(시안 04): 헤더 제목 「공간」 + 카드형 섹션. 없으면 false. */
  readonly compact?: boolean;
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
  /** R4 「이동…」 버튼 → 공간 전환기(D §7-3 Ctrl/⌘+K). 없으면(compact) 렌더하지 않는다. */
  readonly onOpenSwitcher?: () => void;
  /** R4 내비게이션 접기/펼치기(wide, §5-2 자동 접힘 중이 아닐 때만). */
  readonly onToggleCollapse?: () => void;
  /** 오류 상태 「다시 시도」. */
  readonly onRetryList?: () => void;
  /** owner 전용 하단 「멤버 관리」(`/settings/members`). role이 owner가 아니면 렌더하지 않는다. */
  readonly onManageMembers?: () => void;
  /** 하단 「로그아웃」. */
  readonly onLogout?: () => void;
  /** 계정 영역 알림 설정(CMP-30, ★Q-H4). 없으면 렌더하지 않는다. */
  readonly pushSettings?: ReactNode;
  /** 「나간 채널 · 다시 참여」(UI_STATES §2-3) → `POST …/join`. 없으면 버튼을 렌더하지 않는다. */
  readonly onRejoin?: (id: string) => void;
}

/** 접힘 상태 항목 이름: 이름 + 상태(디자인 §7-2 "접힘 상태는 각 항목 aria-label에 이름+상태 포함"). */
function collapsedLabel(space: Space): string {
  const parts = [withBotLabel(space.name, space.bot === true)];
  if (space.mentionCount > 0) parts.push(mentionLabel(space.mentionCount));
  if (space.unreadThreadCount > 0) parts.push(threadDotLabel(space.unreadThreadCount));
  return parts.join(COLLAPSED_LABEL_SEPARATOR);
}

/** CMP-03 SpaceListItem — 굵게(unread)·배지(멘션)·점(새 답글) 세 표시는 독립(UI_STATES §2-3). */
function SpaceListItem({ space, selected, collapsed, onSelect, onRejoin }: {
  readonly space: Space;
  readonly selected: boolean;
  readonly collapsed: boolean;
  /** compact(≤640) 전체 화면 공간 목록(시안 04): 헤더 제목 「공간」 + 카드형 섹션. 없으면 false. */
  readonly compact?: boolean;
  readonly onSelect: (id: string) => void;
  readonly onRejoin?: (id: string) => void;
}) {
  const left = space.left === true;
  // QA D3: 비활성 DM 상대는 이름만 말줄임, 「(비활성)」은 항상 보이고 전체 이름은 title로.
  const split = !collapsed && isSplitName(space.name, space.peerInactiveName);
  const classes = ['space-item', selected ? 'space-selected' : '', space.unreadCount > 0 ? 'space-unread' : '', left ? 'space-left' : '']
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
        {...(collapsed ? { 'data-initial': Array.from(space.name)[0] ?? '' } : {})}
        onClick={() => onSelect(space.id)}
      >
        <span className="space-status" aria-hidden="true" />
        <span className={collapsed ? 'visually-hidden' : split ? 'space-name name-split' : 'space-name'} title={split ? space.name : undefined}>
          <NameParts label={space.name} inactiveName={space.peerInactiveName} />
        </span>
        {space.bot === true && !collapsed && <BotBadge />}
        {space.unreadThreadCount > 0 && (
          <span className="thread-dot" role="img" aria-label={threadDotLabel(space.unreadThreadCount)}>
            ↳
          </span>
        )}
        <UnreadBadge count={space.mentionCount} />
      </button>
      {left && onRejoin && !collapsed && (
        <button type="button" className="btn btn-secondary space-rejoin" onClick={() => onRejoin(space.id)}>
          {LEFT_CHANNEL_COPY.rejoinRow}
        </button>
      )}
    </li>
  );
}

/** 봇 DM 최상단 고정(UI_STATES §2-3 「Jarvis DM」, W-19b). 봇 DM끼리·나머지끼리는 목록 순서 그대로(안정 분할). */
export function pinBotDms(dms: readonly Space[]): readonly Space[] {
  return [...dms.filter((s) => s.bot === true), ...dms.filter((s) => s.bot !== true)];
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
    <div className="space-sections">
      <SpaceSection {...props} title={SIDEBAR_SHELL_COPY.sectionChannels} spaces={spaces.filter((s) => s.kind === 'channel')} />
      <SpaceSection {...props} title={SIDEBAR_SHELL_COPY.sectionDms} spaces={pinBotDms(spaces.filter((s) => s.kind !== 'channel'))} />
    </div>
  );
}

/** 섹션 「채널」·「대화」(시안 01·04·09). 같은 종류 안의 순서는 목록 순서 그대로. 빈 섹션은 렌더하지 않는다. */
function SpaceSection(props: SidebarProps & { readonly title: string }) {
  const titleId = useId();
  if (props.spaces.length === 0) return null;
  return (
    <section className="space-section" aria-labelledby={titleId}>
      <h2 id={titleId} className={props.collapsed ? 'visually-hidden' : 'space-section-title'}>
        {props.title}
      </h2>
      <ul className="space-list">
        {props.spaces.map((space) => (
          <SpaceListItem
            key={space.id}
            space={space}
            selected={space.id === props.selectedId}
            collapsed={props.collapsed}
            onSelect={props.onSelect}
            {...(props.onRejoin ? { onRejoin: props.onRejoin } : {})}
          />
        ))}
      </ul>
    </section>
  );
}

/** 아이콘 단독 버튼: 접근 이름·툴팁 = 기존 문구(§3-4 「아이콘 단독 버튼이면 aria-label」). */
function IconAction({ label, onClick, children }: { readonly label: string; readonly onClick: () => void; readonly children: ReactNode }) {
  return (
    <button type="button" className="icon-button sidebar-icon-action" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

/** 하단 계정 카드(시안 01): 이니셜 원형 + 표시 이름 + 역할. */
function AccountCard({ account, children }: { readonly account: Account; readonly children?: ReactNode }) {
  return (
    <div className="account-card">
      {/* 이니셜은 CSS `attr()`로 그린다 — 장식이라 텍스트 노드로 두면 표시 이름 텍스트 질의가 중복된다. */}
      <span className="account-avatar" aria-hidden="true" data-initial={Array.from(account.displayName)[0] ?? ''} />
      <span className="account-meta">
        <span className="account-name" title={account.displayName}>
          {account.displayName}
        </span>
        <span className="account-role">{MEMBER_ADMIN_COPY.roles[account.role]}</span>
      </span>
      {children}
    </div>
  );
}

/**
 * CMP-02 Sidebar · CMP-03 SpaceList — `nav aria-label="공간"`(디자인 §7-2).
 * 상단 「채널 찾기」·「DM 시작」(+ owner 「채널 만들기」), 하단 내 계정(표시 이름 + 「로그아웃」).
 * 하단 `.sidebar-account`에 owner 전용 「멤버 관리」 진입점(W-10h).
 * W-11a(시안 01·04·09): 앱 심볼 헤더(compact는 「공간」 제목), 섹션 「채널」·「대화」, 계정 카드.
 */
export function Sidebar(props: SidebarProps) {
  const { collapsed, account } = props;
  return (
    <nav className="sidebar" aria-label={SIDEBAR_SHELL_COPY.spaces} data-collapsed={collapsed ? 'true' : 'false'}>
      <header className="sidebar-header">
        <span className="app-mark">
          <AppMark />
        </span>
        {props.compact === true ? (
          <h1 className="sidebar-title">{SIDEBAR_SHELL_COPY.spaces}</h1>
        ) : (
          <span className={collapsed ? 'visually-hidden' : 'sidebar-app-name'}>{APP_NAME}</span>
        )}
        {props.onToggleCollapse && !collapsed && (
          <IconAction label={SIDEBAR_SHELL_COPY.collapseNav} onClick={props.onToggleCollapse}>
            <PanelLeftIcon />
          </IconAction>
        )}
      </header>
      {/* R4 시안: 「이동…」(전환기) + 공간 작업은 아이콘 버튼(접근 이름 = 기존 문구, 툴팁 같은 값). */}
      <div className="sidebar-actions">
        {props.onOpenSwitcher && !collapsed && (
          <button
            type="button"
            className="sidebar-jump"
            aria-label={SIDEBAR_SHELL_COPY.jumpLabel}
            aria-keyshortcuts="Control+K Meta+K"
            onClick={props.onOpenSwitcher}
          >
            <SearchIcon />
            <span className="sidebar-jump-text">{SIDEBAR_SHELL_COPY.jump}</span>
            <kbd className="sidebar-jump-keys" aria-hidden="true">
              {SIDEBAR_SHELL_COPY.jumpKeys}
            </kbd>
          </button>
        )}
        {props.onBrowseChannels && (
          <IconAction label={SIDEBAR_COPY.browseChannels} onClick={props.onBrowseChannels}>
            <HashIcon />
          </IconAction>
        )}
        {props.onStartDm && (
          <IconAction label={SIDEBAR_COPY.startDm} onClick={props.onStartDm}>
            <MessageSquareIcon />
          </IconAction>
        )}
        {account?.role === 'owner' && props.onCreateChannel && (
          <IconAction label={SIDEBAR_COPY.createChannel} onClick={props.onCreateChannel}>
            <PlusIcon />
          </IconAction>
        )}
      </div>
      <SpaceListBody {...props} />
      {props.onToggleCollapse && collapsed && (
        <div className="sidebar-expand">
          <IconAction label={SIDEBAR_SHELL_COPY.expandNav} onClick={props.onToggleCollapse}>
            <PanelLeftIcon />
          </IconAction>
        </div>
      )}
      {account !== undefined && (
        <div className="sidebar-account">
          <AccountCard account={account}>
            {account.role === 'owner' && props.onManageMembers && (
              <IconAction label={MEMBER_ADMIN_COPY.title} onClick={props.onManageMembers}>
                <UsersIcon />
              </IconAction>
            )}
            {props.onLogout && (
              <IconAction label={SIDEBAR_COPY.logout} onClick={props.onLogout}>
                <LogOutIcon />
              </IconAction>
            )}
          </AccountCard>
          {!collapsed && props.pushSettings}
        </div>
      )}
    </nav>
  );
}
