import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { formatRoute, parseRoute, type RouteHistory } from '../../app/route.js';
import type { DataSource, Message, Space } from '../../data';
import { Composer, MessageItem, createDraftStore, type DraftStore } from '../conversation';
import { Sidebar } from '../sidebar';
import { ConnectionBanner } from '../sync';
import { COMPOSER_COPY, DIALOG_CLOSE_LABEL, messageComposerLabel } from '../../ui/copy.js';
import { MemberAdmin } from '../members';
import { ThreadPanel } from '../thread';
import { LeaveChannelControl, LeftChannelNotice, RejoinButton, useMentionCandidates } from '../conversation-membership';
import type { MentionCandidate } from '../conversation';
import type { ActionResult } from '../../data';
import { SpacePanel, type PanelKind } from './SpacePanel.js';
import { initialShellState, shellReducer, adjacentSpace } from './shell-state.js';
import { isSidebarCollapsed, useViewport, type Breakpoint } from './viewport.js';

export interface AppShellProps {
  readonly dataSource: DataSource;
  /** 작성기 초안 저장소(디자인 §7-3 초안 규칙). 로그아웃·401에서 소유자가 `clear()`로 폐기한다. 없으면 셸이 만든다. */
  readonly drafts?: DraftStore;
  /**
   * 주소 동기화(W-10g). 있으면 대화 선택 → `/c/:id` push, 새로고침 → `/c/:id` 복원, 뒤로가기(`popstate`) → 선택 복원.
   * 없으면 주소를 건드리지 않는다(메모리 개발 루트·기존 테스트).
   */
  readonly history?: RouteHistory;
}

/** 주소 ↔ 패널: `/discover`(채널 찾기)·`/dm/new`(DM 시작). 채널 만들기는 경로가 없다(D §4-2). */
const PANEL_ROUTES: Readonly<Partial<Record<PanelKind, '/discover' | '/dm/new'>>> = { browse: '/discover', dm: '/dm/new' };

function panelFrom(history: RouteHistory | undefined): PanelKind | null {
  const kind = history === undefined ? null : parseRoute(history.pathname()).kind;
  return kind === 'discover' ? 'browse' : kind === 'dm-new' ? 'dm' : null;
}

/** 주소가 `/settings/members`인가(새로고침 복원·뒤로가기). */
function membersFrom(history: RouteHistory | undefined): boolean {
  return history !== undefined && parseRoute(history.pathname()).kind === 'members';
}

/** 첫 상태: 주소가 `/c/:id`면 그 대화(새로고침 복원). */
function initialFrom(history: RouteHistory | undefined) {
  const route = history === undefined ? null : parseRoute(history.pathname());
  return route?.kind === 'conversation' ? { conversationId: route.conversationId, threadRootId: null } : initialShellState;
}

function spaceTitle(space: Space): string {
  return space.kind === 'channel' ? `#${space.name}` : space.name;
}

/** CMP-05 ConversationHeader(골격) + CMP-06 MessageList + CMP-11 Composer. */
function ConversationPane(props: {
  readonly space: Space;
  readonly roots: readonly Message[];
  readonly breakpoint: Breakpoint;
  readonly inert: boolean;
  readonly drafts: DraftStore;
  readonly onBack: () => void;
  readonly onReply: (id: string) => void;
  readonly onSend: (body: string, mentionUserIds?: readonly string[]) => void;
  readonly onRetry: (clientMessageId: string) => void;
  readonly onDiscard: (clientMessageId: string) => void;
  /** W-10j: 채널 나가기·다시 참여·멘션 후보(없으면 렌더하지 않음). */
  readonly membership?: MembershipProps;
}) {
  const { space, roots, breakpoint, membership } = props;
  const left = space.left === true;
  return (
    <main className="conversation-pane" inert={props.inert}>
      <header className="conversation-header">
        {breakpoint === 'compact' && (
          <button type="button" onClick={props.onBack}>
            뒤로
          </button>
        )}
        <h1 className="conversation-title">{spaceTitle(space)}</h1>
        {membership && space.kind === 'channel' && !left && membership.onLeave && <LeaveChannelControl onLeave={membership.onLeave} />}
        {membership && left && <RejoinButton onRejoin={membership.onRejoin} />}
      </header>
      {membership && left ? (
        <LeftChannelNotice onRejoin={membership.onRejoin} />
      ) : roots.length === 0 ? (
        <p className="message-empty">첫 메시지를 남겨 보세요</p>
      ) : (
        <ul className="message-list">
          {roots.map((m) => (
            <MessageItem key={m.id} message={m} onReply={props.onReply} onRetry={props.onRetry} onDiscard={props.onDiscard} />
          ))}
        </ul>
      )}
      {!left && (
        <div data-composer="main">
          <Composer
            key={space.id}
            label={messageComposerLabel(spaceTitle(space))}
            placeholder={COMPOSER_COPY.messagePlaceholder}
            onSend={props.onSend}
            draft={{ store: props.drafts, key: space.id }}
            {...(membership?.mentions === undefined ? {} : { mentions: membership.mentions })}
          />
        </div>
      )}
    </main>
  );
}

interface MembershipProps {
  readonly onLeave?: () => Promise<ActionResult<null>>;
  readonly onRejoin: () => void;
  readonly mentions?: { readonly candidates: readonly MentionCandidate[]; readonly selfId?: string };
}

/** CMP-01 AppShell — 3/2/1단, §5-2 접힘 규칙, 포커스 관리(디자인 §5·§7-3, UI_STATES §2-2·§3·§4-2). */
export function AppShell({ dataSource, drafts: injectedDrafts, history }: AppShellProps) {
  const [drafts] = useState(() => injectedDrafts ?? createDraftStore());
  const snap = useSyncExternalStore(dataSource.subscribe, dataSource.getSnapshot, dataSource.getSnapshot);
  const viewport = useViewport();
  const [state, dispatch] = useReducer(shellReducer, history, initialFrom);
  const [panel, setPanelState] = useState<PanelKind | null>(() => panelFrom(history));
  const [members, setMembers] = useState(() => membersFrom(history));
  /** MemberAdmin 요청 함수(안정 참조 — 렌더마다 목록을 다시 읽지 않게). 구현이 없으면 403과 같게 본다. */
  const memberApi = useMemo(() => {
    const denied = { ok: false, status: 403 } as const;
    return {
      load: () => dataSource.listMembers?.() ?? Promise.resolve(denied),
      createInvite: () => dataSource.createInvite?.() ?? Promise.resolve(denied),
      deactivate: (id: string) => dataSource.deactivateMember?.(id) ?? Promise.resolve(denied),
    };
  }, [dataSource]);
  const routed = useRef(false);
  const [announcement, setAnnouncement] = useState('');
  const shell = useRef<HTMLDivElement>(null);
  const prevThread = useRef<string | null>(null);
  const focusComposer = useRef(false);

  const space = snap.spaces.find((s) => s.id === state.conversationId);
  const root = snap.messages.find((m) => m.id === state.threadRootId && m.conversationId === state.conversationId);
  // 나간 채널은 스레드도 닫힌 것으로 본다 — 답글 작성기로 나간 채널에 보내지 않게(Codex r1 P2).
  const threadOpen = space !== undefined && root !== undefined && space.left !== true;
  const collapsed = isSidebarCollapsed(viewport, threadOpen);
  const bp = viewport.breakpoint;

  // F1: 스레드가 닫히면 그 스레드를 연 원문의 「답글」 버튼으로 포커스 복귀.
  useEffect(() => {
    const prev = prevThread.current;
    prevThread.current = state.threadRootId;
    if (prev !== null && state.threadRootId === null) {
      shell.current?.querySelector<HTMLElement>(`[data-reply-for="${CSS.escape(prev)}"]`)?.focus();
    }
  }, [state.threadRootId]);

  // 주소 ← 선택 대화. 첫 실행은 replace(로그인 직후 `/login` 등 정규화), 이후 선택 변경은 push(UI_STATES §3-3 T1).
  useEffect(() => {
    if (history === undefined) return;
    const target = members
      ? formatRoute({ kind: 'members' })
      : formatRoute(state.conversationId === null ? { kind: 'root' } : { kind: 'conversation', conversationId: state.conversationId });
    const first = !routed.current;
    routed.current = true;
    // `/discover`·`/dm/new` 직접 진입은 패널 경로를 그대로 둔다.
    if (history.pathname() === target || (first && panelFrom(history) !== null)) return;
    if (first) history.replace(target);
    else history.push(target);
  }, [history, state.conversationId, members]);

  // 뒤로·앞으로 → 선택 복원. 열린 공간 Dialog·화면은 닫는다.
  useEffect(
    () =>
      history?.listen(() => {
        const route = parseRoute(history.pathname());
        setPanelState(panelFrom(history));
        setMembers(route.kind === 'members');
        dispatch({ type: 'route', conversationId: route.kind === 'conversation' ? route.conversationId : null });
      }),
    [history],
  );

  // 현재 대화 구독·이력 로드(HTTP 구현). 메모리 구현은 open이 없다.
  useEffect(() => {
    dataSource.open?.(state.conversationId);
  }, [dataSource, state.conversationId]);

  // 스레드 기존 답글 조회(HTTP 구현, Codex r2 P1).
  useEffect(() => {
    dataSource.openThread?.(state.threadRootId);
  }, [dataSource, state.threadRootId]);

  // F4: 공간 전환 후 새 공간의 작성기.
  useEffect(() => {
    if (!focusComposer.current) return;
    focusComposer.current = false;
    shell.current?.querySelector<HTMLElement>('[data-composer="main"] textarea')?.focus();
  }, [state.conversationId]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (bp === 'compact' || !e.ctrlKey || !e.altKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const unread = new Set(snap.spaces.filter((s) => s.unreadCount > 0).map((s) => s.id));
    const next = adjacentSpace(
      snap.spaces.map((s) => s.id),
      state.conversationId,
      e.key === 'ArrowDown' ? 1 : -1,
      e.shiftKey ? (id) => unread.has(id) : undefined,
    );
    if (next === null) return;
    setMembers(false);
    focusComposer.current = true;
    dispatch({ type: 'select-space', conversationId: next });
  };

  const closeThread = () => dispatch({ type: 'close-thread' });
  // 전송 FSM 재사용(W-10a): 다시 시도는 같은 client_message_id로 1회 재전송, 삭제는 대기 항목 제거.
  const retry = (clientMessageId: string) => dataSource.retry?.(clientMessageId);
  const discard = (clientMessageId: string) => dataSource.discard?.(clientMessageId);
  /** 패널 열기·닫기 + compact 주소(UI_STATES §3-2: compact는 `/discover`·`/dm/new` 화면). 닫으면 대화 주소로 replace. */
  const setPanel = (next: PanelKind | null) => {
    setPanelState(next);
    if (history === undefined) return;
    const path = next === null ? undefined : PANEL_ROUTES[next];
    if (path !== undefined && bp === 'compact') history.push(path);
    else if (next === null && panelFrom(history) !== null) {
      history.replace(formatRoute(state.conversationId === null ? { kind: 'root' } : { kind: 'conversation', conversationId: state.conversationId }));
    }
  };
  /** 생성·참여·DM 성공: 목록은 DataSource가 이미 갱신했다 → 패널 닫기 → 그 대화로 이동(구독은 `open` 효과가 기존 규칙으로). */
  const goTo = (conversationId: string) => {
    setPanel(null);
    setMembers(false);
    focusComposer.current = true;
    dispatch({ type: 'select-space', conversationId });
  };
  /** W-10j 다시 참여: join 2xx → 그 대화로 이동 + 이력·구독 재개(`open`). 선택 중이면 effect가 다시 돌지 않아 직접 연다. */
  const rejoin = (conversationId: string) => {
    void dataSource.joinChannel?.(conversationId).then((res) => {
      if (!res.ok) return;
      goTo(res.value);
      dataSource.open?.(res.value);
    });
  };
  const mentionCandidates = useMentionCandidates(dataSource, space?.id ?? null, space !== undefined && space.left !== true);
  const membership: MembershipProps | undefined =
    space === undefined || !dataSource.joinChannel
      ? undefined
      : {
          ...(dataSource.leaveChannel ? { onLeave: () => dataSource.leaveChannel?.(space.id) ?? Promise.resolve({ ok: false, status: 403 } as const) } : {}),
          onRejoin: () => rejoin(space.id),
          ...(mentionCandidates === undefined
            ? {}
            : { mentions: { candidates: mentionCandidates, ...(snap.account === undefined ? {} : { selfId: snap.account.id }) } }),
        };
  const sidebar = (
    <Sidebar
      spaces={snap.spaces}
      selectedId={state.conversationId}
      collapsed={collapsed}
      onSelect={(id) => {
        setMembers(false);
        dispatch({ type: 'select-space', conversationId: id });
      }}
      {...(snap.account === undefined ? {} : { account: snap.account })}
      {...(snap.listState === undefined ? {} : { listState: snap.listState })}
      {...(dataSource.discoverChannels && dataSource.joinChannel ? { onBrowseChannels: () => setPanel('browse') } : {})}
      {...(dataSource.listMembers && dataSource.startDm ? { onStartDm: () => setPanel('dm') } : {})}
      {...(dataSource.createChannel ? { onCreateChannel: () => setPanel('create') } : {})}
      {...(dataSource.reload ? { onRetryList: () => dataSource.reload?.() } : {})}
      {...(dataSource.listMembers && dataSource.createInvite && dataSource.deactivateMember
        ? { onManageMembers: () => setMembers(true) }
        : {})}
      {...(dataSource.logout ? { onLogout: () => void dataSource.logout?.() } : {})}
      {...(dataSource.joinChannel ? { onRejoin: rejoin } : {})}
    />
  );
  const spacePanel = panel !== null && (
    <SpacePanel
      kind={panel}
      breakpoint={bp}
      dataSource={dataSource}
      selfId={snap.account?.id}
      onClose={() => setPanel(null)}
      onDone={goTo}
    />
  );
  const memberAdmin = members && (
    <div className="member-admin-screen">
      {bp === 'compact' && (
        <button type="button" className="btn btn-secondary" onClick={() => setMembers(false)}>
          {DIALOG_CLOSE_LABEL}
        </button>
      )}
      <MemberAdmin
        account={snap.account}
        {...memberApi}
      />
    </div>
  );
  const pane = space && (
    <ConversationPane
      space={space}
      roots={snap.messages.filter((m) => m.conversationId === space.id && m.rootId === undefined)}
      breakpoint={bp}
      inert={bp === 'medium' && threadOpen}
      drafts={drafts}
      onBack={() => dispatch({ type: 'back' })}
      onReply={(id) => dispatch({ type: 'open-thread', rootId: id })}
      onSend={(body, mentionUserIds) => dataSource.send({ conversationId: space.id }, body, mentionUserIds)}
      onRetry={retry}
      onDiscard={discard}
      {...(membership === undefined ? {} : { membership })}
    />
  );
  const thread = threadOpen && space && root && (
    <ThreadPanel
      variant={bp}
      root={root}
      replies={snap.messages.filter((m) => m.rootId === root.id)}
      onClose={closeThread}
      onSend={(body) => dataSource.send({ conversationId: space.id, rootId: root.id }, body)}
      announce={setAnnouncement}
      drafts={drafts}
      onRetry={retry}
      onDiscard={discard}
    />
  );
  const compactScreen = (bp === 'compact' && spacePanel) || memberAdmin || thread || pane || sidebar;

  return (
    <div
      ref={shell}
      className="app-shell"
      data-layout={bp}
      data-sidebar={collapsed ? 'collapsed' : 'expanded'}
      data-thread={threadOpen ? 'open' : 'closed'}
      onKeyDown={onKeyDown}
    >
      <ConnectionBanner state={snap.connection} />
      {bp === 'compact' ? compactScreen : (
        <>
          {sidebar}
          {memberAdmin || pane}
          {!members && thread}
          {spacePanel}
        </>
      )}
      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
