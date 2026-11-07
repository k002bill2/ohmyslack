import { useEffect, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { DataSource, Message, Space } from '../../data';
import { Composer, MessageItem, createDraftStore, type DraftStore } from '../conversation';
import { Sidebar } from '../sidebar';
import { ConnectionBanner } from '../sync';
import { ThreadPanel } from '../thread';
import { initialShellState, shellReducer, adjacentSpace } from './shell-state.js';
import { isSidebarCollapsed, useViewport, type Breakpoint } from './viewport.js';

export interface AppShellProps {
  readonly dataSource: DataSource;
  /** 작성기 초안 저장소(디자인 §7-3 초안 규칙). 로그아웃·401에서 소유자가 `clear()`로 폐기한다. 없으면 셸이 만든다. */
  readonly drafts?: DraftStore;
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
            <MessageItem key={m.id} message={m} onReply={props.onReply} />
          ))}
        </ul>
      )}
      <div data-composer="main">
        <Composer
          key={space.id}
          label={space.name}
          onSend={props.onSend}
          draft={{ store: props.drafts, key: space.id }}
        />
      </div>
    </main>
  );
}

/** CMP-01 AppShell — 3/2/1단, §5-2 접힘 규칙, 포커스 관리(디자인 §5·§7-3, UI_STATES §2-2·§3·§4-2). */
export function AppShell({ dataSource, drafts: injectedDrafts }: AppShellProps) {
  const [drafts] = useState(() => injectedDrafts ?? createDraftStore());
  const snap = useSyncExternalStore(dataSource.subscribe, dataSource.getSnapshot, dataSource.getSnapshot);
  const viewport = useViewport();
  const [state, dispatch] = useReducer(shellReducer, initialShellState);
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

  // 현재 대화 구독·이력 로드(HTTP 구현). 메모리 구현은 open이 없다.
  useEffect(() => {
    dataSource.open?.(state.conversationId);
  }, [dataSource, state.conversationId]);

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
  const sidebar = (
    <Sidebar
      spaces={snap.spaces}
      selectedId={state.conversationId}
      collapsed={collapsed}
      onSelect={(id) => dispatch({ type: 'select-space', conversationId: id })}
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
    />
  );
  const compactScreen = thread || pane || sidebar;

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
        </>
      )}
      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
