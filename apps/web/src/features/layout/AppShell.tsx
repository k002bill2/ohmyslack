import { Fragment, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { formatRoute, parseRoute, parseThreadParam, withThread, type RouteHistory } from '../../app/route.js';
import type { DataSource, Message, Space } from '../../data';
import { Composer, DateSeparator, bodyMentionsName, MessageItem, NewMessagesDivider, createDraftStore, lastServerSeq, type DraftStore, type MessageItemProps } from '../conversation';
import { Sidebar } from '../sidebar';
import { PanelRightIcon } from '../sidebar/icons.js';
import { ConnectionBanner } from '../sync';
import { COMPOSER_COPY, DIALOG_CLOSE_LABEL, messageComposerLabel } from '../../ui/copy.js';
import { MemberAdmin } from '../members';
import { ThreadPanel } from '../thread';
import { InstallCard } from '../pwa';
import { LeaveChannelControl, LeftChannelNotice, RejoinButton, useMentionCandidates } from '../conversation-membership';
import type { MentionCandidate } from '../conversation';
import type { ActionResult } from '../../data';
import { SHELL_COPY } from './copy.js';
import { startsNewDay, useNewMessagesSeq } from './message-dividers.js';
import { isAtBottom, usePinBottom } from './pin-bottom.js';
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
  return route?.kind === 'conversation' ? { conversationId: route.conversationId, threadRootId: threadFrom(history) } : initialShellState;
}

/** 주소의 `?thread=:rootMessageId`(W-10i). 쿼리를 못 읽는 history면 null. */
function threadFrom(history: RouteHistory | undefined): string | null {
  return parseThreadParam(history?.search?.() ?? '');
}

/** 메시지 항목 공통 props(W-10i): 본인 액션·스레드 요약. */
type ItemActions = Pick<MessageItemProps, 'selfId' | 'onEdit' | 'onDelete' | 'onOpenThread' | 'threadHolding'>;

function spaceTitle(space: Space): string {
  return space.kind === 'channel' ? `#${space.name}` : space.name;
}

/** 메시지 객체(불변)별 판정 캐시 — 렌더마다 모든 본문을 다시 파싱하지 않게(F-1). */
const mentionCache = new WeakMap<Message, { readonly name: string; readonly hit: boolean }>();

/**
 * 「나를 멘션」 판정: 클라이언트 모델에 mention_user_ids가 없어(data 계층은 이 레인 밖) 본문의 `@내 이름` 토큰으로 본다(W-11d REPORT).
 */
function mentionsName(m: Message, name: string): boolean {
  const cached = mentionCache.get(m);
  if (cached?.name === name) return cached.hit;
  const hit = bodyMentionsName(m.body, name);
  mentionCache.set(m, { name, hit });
  return hit;
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
  readonly itemActions?: ItemActions;
  /** W-10j: 채널 나가기·다시 참여·멘션 후보(없으면 렌더하지 않음). */
  readonly membership?: MembershipProps;
  /** FR-SYNC-03: 목록이 맨 아래(마지막 원문이 보임)일 때 그 seq를 알린다. */
  readonly onSeen?: (seq: number) => void;
  /** wide에서 스레드가 열려 있으면 헤더 오른쪽 패널 토글(시안 01)로 닫는다. */
  readonly onCloseThread?: () => void;
  /** catch-up 중 — 「여기부터 새 메시지」 위치 계산 보류(UI_STATES §2-4). */
  readonly holding: boolean;
  /** 본문 `@이름` 토큰 근거(대화 멤버 이름)와 내 표시 이름(「나를 멘션」 판정). */
  readonly mentionNames?: readonly string[];
  readonly selfName?: string;
}) {
  const { space, roots, breakpoint, membership, onSeen } = props;
  const newSeq = useNewMessagesSeq(space.id, space.unreadCount, roots, props.holding);
  const { mentionNames, selfName } = props;
  const selfId = props.itemActions?.selfId;
  const mentionsSelf = (m: Message) => selfName !== undefined && m.deleted !== true && (selfId === undefined || m.authorId !== selfId) && mentionsName(m, selfName);
  const memberCount = space.kind === 'channel' ? (membership?.mentions?.candidates.length ?? 0) : 0;
  const left = space.left === true;
  const list = useRef<HTMLUListElement>(null);
  const onPinScroll = usePinBottom(list, space.id);
  const lastSeq = lastServerSeq(roots);
  const reportSeen = () => {
    const el = list.current;
    if (el !== null && lastSeq !== undefined && isAtBottom(el)) onSeen?.(lastSeq);
  };
  // 렌더 후(새 메시지·전환·전경 복귀 재렌더)와 스크롤 때 맨 아래면 본 위치를 알린다. 판정(전경·현재 대화·단조)은 DataSource.
  useEffect(reportSeen);
  const onListScroll = () => {
    onPinScroll();
    reportSeen();
  };
  return (
    <main className="conversation-pane" inert={props.inert}>
      <header className="conversation-header">
        {breakpoint === 'compact' && (
          <button type="button" onClick={props.onBack}>
            뒤로
          </button>
        )}
        <div className="conversation-heading">
          <h1 className="conversation-title">{spaceTitle(space)}</h1>
          <span className="conversation-meta">
            {memberCount > 0 ? SHELL_COPY.channelMeta(memberCount) : SHELL_COPY.kind[space.kind]}
          </span>
        </div>
        {membership && space.kind === 'channel' && !left && membership.onLeave && <LeaveChannelControl onLeave={membership.onLeave} />}
        {membership && left && <RejoinButton onRejoin={membership.onRejoin} />}
        {props.onCloseThread && (
          <button
            type="button"
            className="icon-button"
            aria-label={SHELL_COPY.closeThreadPanel}
            aria-pressed="true"
            title={SHELL_COPY.closeThreadPanel}
            onClick={props.onCloseThread}
          >
            <PanelRightIcon />
          </button>
        )}
      </header>
      {membership && left ? (
        <LeftChannelNotice onRejoin={membership.onRejoin} />
      ) : roots.length === 0 ? (
        <p className="message-empty">첫 메시지를 남겨 보세요</p>
      ) : (
        <ul ref={list} className="message-list" onScroll={onListScroll}>
          {roots.map((m, i) => (
            <Fragment key={m.id}>
              {startsNewDay(roots, i) && <DateSeparator at={m.createdAt} />}
              {newSeq !== null && m.seq === newSeq && <NewMessagesDivider />}
              <MessageItem
                message={m}
                onReply={props.onReply}
                onRetry={props.onRetry}
                onDiscard={props.onDiscard}
                {...props.itemActions}
                threadUnread={space.unreadThreadRoots?.includes(m.id) === true}
                timePlacement={breakpoint === 'compact' ? 'below' : 'inline'}
                mentionsSelf={mentionsSelf(m)}
                {...(mentionNames === undefined ? {} : { mentionNames })}
              />
            </Fragment>
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
      // 삭제된 원문은 「답글」이 없다(§2-5) → 연 버튼 CMP-14로(UI_STATES F1 「또는 연 버튼」).
      const id = CSS.escape(prev);
      const target =
        shell.current?.querySelector<HTMLElement>(`[data-reply-for="${id}"]`) ??
        shell.current?.querySelector<HTMLElement>(`[data-thread-summary-for="${id}"]`) ??
        // compact는 인라인 「답글」이 없다(시안 08 액션 시트) — 원문 항목 자체로(W-11d).
        shell.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
      target?.focus();
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
        // `?thread=` 복원·뒤로가기로 닫힘(W-10i).
        const thread = route.kind === 'conversation' ? threadFrom(history) : null;
        dispatch(thread === null ? { type: 'close-thread' } : { type: 'open-thread', rootId: thread });
      }),
    [history],
  );

  // 주소 ← 스레드(W-10i, D §4-2): 열기 → `?thread=` push, 닫기 → 쿼리 제거(replace). 주소와 같으면 그대로.
  useEffect(() => {
    if (history === undefined || members || state.conversationId === null) return;
    if (threadFrom(history) === state.threadRootId) return;
    const path = formatRoute({ kind: 'conversation', conversationId: state.conversationId });
    if (history.pathname() !== path) return;
    if (state.threadRootId === null) history.replace(path);
    else history.push(withThread(path, state.threadRootId));
  }, [history, members, state.conversationId, state.threadRootId]);

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
  const messageActions = {
    ...(snap.account === undefined ? {} : { selfId: snap.account.id }),
    ...(dataSource.editMessage === undefined ? {} : { onEdit: (id: string, body: string) => dataSource.editMessage!(id, body) }),
    ...(dataSource.deleteMessage === undefined ? {} : { onDelete: (id: string) => dataSource.deleteMessage!(id) }),
  };
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
  // 로딩 중 훅이 매번 새 []를 돌려줘도 같은 undefined가 되게 — memo(MessageItem)·MessageBody useMemo를 깨지 않는다.
  const mentionNames = useMemo(
    () => (mentionCandidates === undefined || mentionCandidates.length === 0 ? undefined : mentionCandidates.map((c) => c.displayName)),
    [mentionCandidates],
  );
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
      compact={bp === 'compact'}
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
      itemActions={{
        ...messageActions,
        onOpenThread: (id) => dispatch({ type: 'open-thread', rootId: id }),
        threadHolding: snap.connection === 'catching-up',
      }}
      {...(membership === undefined ? {} : { membership })}
      onSeen={(seq) => dataSource.markRead?.(space.id, null, seq)}
      {...(bp === 'wide' && threadOpen ? { onCloseThread: closeThread } : {})}
      holding={snap.connection === 'catching-up'}
      {...(mentionNames === undefined ? {} : { mentionNames })}
      {...(snap.account === undefined ? {} : { selfName: snap.account.displayName })}
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
      messageActions={messageActions}
      onSeen={(seq) => dataSource.markRead?.(space.id, root.id, seq)}
      spaceTitle={spaceTitle(space)}
    />
  );
  // 시안 04: compact 공간 목록 위 설치 안내 카드(standalone·미지원이면 InstallCard가 렌더하지 않음).
  const compactScreen = (bp === 'compact' && spacePanel) || memberAdmin || thread || pane || (
    <>
      <InstallCard />
      {sidebar}
    </>
  );

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
