import { useEffect, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { formatRoute, parseRoute, type RouteHistory } from '../../app/route.js';
import type { DataSource, Message, Space } from '../../data';
import { Composer, MessageItem, createDraftStore, type DraftStore } from '../conversation';
import { Sidebar } from '../sidebar';
import { ConnectionBanner } from '../sync';
import { COMPOSER_COPY, messageComposerLabel } from '../../ui/copy.js';
import { ThreadPanel } from '../thread';
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
  readonly onSend: (body: string) => void;
  readonly onRetry: (clientMessageId: string) => void;
  readonly onDiscard: (clientMessageId: string) => void;
}) {
  const { space, roots, breakpoint } = props;
  return (
    <main className="conversation-pane" inert={props.inert}>
      <header className="conversation-header">
        {breakpoint === 'compact' && (
          <button type="button" onClick={props.onBack}>
            뒤로
          </button>
        )}
        <h1 className="conversation-title">{spaceTitle(space)}</h1>
      </header>
      {roots.length === 0 ? (
        <p className="message-empty">첫 메시지를 남겨 보세요</p>
      ) : (
        <ul className="message-list">
          {roots.map((m) => (
            <MessageItem key={m.id} message={m} onReply={props.onReply} onRetry={props.onRetry} onDiscard={props.onDiscard} />
          ))}
        </ul>
      )}
      <div data-composer="main">
        <Composer
          key={space.id}
          label={messageComposerLabel(spaceTitle(space))}
          placeholder={COMPOSER_COPY.messagePlaceholder}
          onSend={props.onSend}
          draft={{ store: props.drafts, key: space.id }}
        />
      </div>
    </main>
  );
}

/** CMP-01 AppShell — 3/2/1단, §5-2 접힘 규칙, 포커스 관리(디자인 §5·§7-3, UI_STATES §2-2·§3·§4-2). */
export function AppShell({ dataSource, drafts: injectedDrafts, history }: AppShellProps) {
  const [drafts] = useState(() => injectedDrafts ?? createDraftStore());
  const snap = useSyncExternalStore(dataSource.subscribe, dataSource.getSnapshot, dataSource.getSnapshot);
  const viewport = useViewport();
  const [state, dispatch] = useReducer(shellReducer, history, initialFrom);
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const routed = useRef(false);
  const [announcement, setAnnouncement] = useState('');
  const shell = useRef<HTMLDivElement>(null);
  const prevThread = useRef<string | null>(null);
  const focusComposer = useRef(false);

  const space = snap.spaces.find((s) => s.id === state.conversationId);
  const root = snap.messages.find((m) => m.id === state.threadRootId && m.conversationId === state.conversationId);
  const threadOpen = space !== undefined && root !== undefined;
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
    const target = formatRoute(state.conversationId === null ? { kind: 'root' } : { kind: 'conversation', conversationId: state.conversationId });
    const first = !routed.current;
    routed.current = true;
    if (history.pathname() === target) return;
    if (first) history.replace(target);
    else history.push(target);
  }, [history, state.conversationId]);

  // 뒤로·앞으로 → 선택 복원. 열린 공간 Dialog·화면은 닫는다.
  useEffect(
    () =>
      history?.listen(() => {
        const route = parseRoute(history.pathname());
        setPanel(null);
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
    focusComposer.current = true;
    dispatch({ type: 'select-space', conversationId: next });
  };

  const closeThread = () => dispatch({ type: 'close-thread' });
  // 전송 FSM 재사용(W-10a): 다시 시도는 같은 client_message_id로 1회 재전송, 삭제는 대기 항목 제거.
  const retry = (clientMessageId: string) => dataSource.retry?.(clientMessageId);
  const discard = (clientMessageId: string) => dataSource.discard?.(clientMessageId);
  /** 생성·참여·DM 성공: 목록은 DataSource가 이미 갱신했다 → 패널 닫기 → 그 대화로 이동(구독은 `open` 효과가 기존 규칙으로). */
  const goTo = (conversationId: string) => {
    setPanel(null);
    focusComposer.current = true;
    dispatch({ type: 'select-space', conversationId });
  };
  const sidebar = (
    <Sidebar
      spaces={snap.spaces}
      selectedId={state.conversationId}
      collapsed={collapsed}
      onSelect={(id) => dispatch({ type: 'select-space', conversationId: id })}
      {...(snap.account === undefined ? {} : { account: snap.account })}
      {...(snap.listState === undefined ? {} : { listState: snap.listState })}
      {...(dataSource.discoverChannels && dataSource.joinChannel ? { onBrowseChannels: () => setPanel('browse') } : {})}
      {...(dataSource.listMembers && dataSource.startDm ? { onStartDm: () => setPanel('dm') } : {})}
      {...(dataSource.createChannel ? { onCreateChannel: () => setPanel('create') } : {})}
      {...(dataSource.reload ? { onRetryList: () => dataSource.reload?.() } : {})}
      {...(dataSource.logout ? { onLogout: () => void dataSource.logout?.() } : {})}
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
  const pane = space && (
    <ConversationPane
      space={space}
      roots={snap.messages.filter((m) => m.conversationId === space.id && m.rootId === undefined)}
      breakpoint={bp}
      inert={bp === 'medium' && threadOpen}
      drafts={drafts}
      onBack={() => dispatch({ type: 'back' })}
      onReply={(id) => dispatch({ type: 'open-thread', rootId: id })}
      onSend={(body) => dataSource.send({ conversationId: space.id }, body)}
      onRetry={retry}
      onDiscard={discard}
    />
  );
  const thread = space && root && (
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
  const compactScreen = (bp === 'compact' && spacePanel) || thread || pane || sidebar;

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
          {pane}
          {thread}
          {spacePanel}
        </>
      )}
      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
