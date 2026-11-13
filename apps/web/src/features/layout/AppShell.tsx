import { Fragment, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { formatRoute, parseRoute, parseThreadParam, withThread, type RouteHistory } from '../../app/route.js';
import type { DataSource, Message, Space, UploadAttachmentOptions } from '../../data';
import type { UploadFn } from '../conversation/attachments/composer-upload.js';
import { Composer, ComposerNotice, DateSeparator, bodyMentionsName, MessageItem, NewMessagesDivider, createDraftStore, lastServerSeq, useFocusOnLock, useMessageRoving, withDiscardFocus, MAIN_DISCARD_FOCUS, type DraftStore, type MessageItemData, type MessageItemProps } from '../conversation';
import { Sidebar } from '../sidebar';
import { PanelRightIcon } from '../sidebar/icons.js';
import { ConnectionBanner } from '../sync';
import { COMPOSER_COPY, DIALOG_CLOSE_LABEL, messageComposerLabel, messagePlaceholder } from '../../ui/copy.js';
import { isSplitName, NameParts } from '../../ui/NameParts.js';
import { MemberAdmin } from '../members';
import { SessionList } from '../sessions';
import { ThreadPanel } from '../thread';
import { browserPushEnv, InstallCard, PushBotHint, PushSettings, useInstallPrompt } from '../pwa';
import { canManageChannelBots, LeftChannelNotice, RejoinButton, useActiveBots, useBotChannelMenu, useConversationMembers, type BotChannelControlProps } from '../conversation-membership';
import type { MentionCandidate } from '../conversation';
import type { ActionResult } from '../../data';
import { SHELL_COPY } from './copy.js';
import { startsNewDay, useNewMessagesSeq } from './message-dividers.js';
import { useMessageAnchor } from './message-anchor.js';
import { isAtBottom, usePinBottom } from './pin-bottom.js';
import { ShortcutsDialog } from './ShortcutsDialog.js';
import { useGlobalShortcuts } from './shortcuts.js';
import { HeaderMenu } from './HeaderMenu.js';
import { MissingConversation } from './MissingConversation.js';
import { prefersNoAutoKeyboard } from '../../ui/no-auto-keyboard.js';
import { useFocusAfterLeave } from './focus-after-leave.js';
import { SpacePanel, type PanelKind } from './SpacePanel.js';
import { SpaceSwitcher } from './SpaceSwitcher.js';
import { initialShellState, shellReducer, adjacentSpace } from './shell-state.js';
import { useSplit } from './useSplit.js';
import { isSidebarCollapsed, useViewport, type Breakpoint } from './viewport.js';
// R4 시안 덮어쓰기 — 다른 기능 CSS(conversation·thread·members)보다 나중에 평가되도록 마지막 import.
import './refresh.css';

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

/** 설정 라우트 화면(`/settings/members`·`/settings/sessions`). */
type SettingsKind = 'members' | 'sessions';

/** 주소의 설정 화면(새로고침 복원·뒤로가기). 아니면 null. */
function settingsFrom(history: RouteHistory | undefined): SettingsKind | null {
  const kind = history === undefined ? null : parseRoute(history.pathname()).kind;
  return kind === 'members' || kind === 'sessions' ? kind : null;
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
type ItemActions = Pick<MessageItemProps, 'selfId' | 'onEdit' | 'onDelete' | 'onOpenThread' | 'threadHolding' | 'messageLink'>;

/** R4 메뉴 「메시지 링크 복사」 주소: `/c/:id(?thread=:root)#message-:id`(알림 탭 앵커와 같은 형식, message-anchor.ts). */
function messageLinkIn(conversationId: string, rootId: string | null): (id: string) => string {
  const path = withThread(formatRoute({ kind: 'conversation', conversationId }), rootId);
  return (id) => `${window.location.origin}${path}#message-${id}`;
}

function spaceTitle(space: Space): string {
  return space.kind === 'channel' ? `#${space.name}` : space.name;
}

/** 대화 머리 H1. 비활성 DM 상대는 이름만 말줄임하고 「(비활성)」은 항상 보인다 — 전체 이름은 title(QA D3). */
function ConversationTitle({ space }: { readonly space: Space }) {
  const title = spaceTitle(space);
  const inactive = space.kind === 'dm' ? space.peerInactiveName : undefined;
  const split = isSplitName(title, inactive);
  return (
    // tabIndex -1: 터치 기기 공간 전환 뒤 자동 포커스 대상(작성기 대신 — 가상 키보드를 띄우지 않게). Tab 순서에는 들지 않는다.
    <h1 className={split ? 'conversation-title name-split' : 'conversation-title'} title={split ? title : undefined} tabIndex={-1}>
      <NameParts label={title} inactiveName={inactive} />
    </h1>
  );
}

/** 메시지 객체(불변)별 판정 캐시 — 렌더마다 모든 본문을 다시 파싱하지 않게(F-1). */
const mentionCache = new WeakMap<MessageItemData, { readonly name: string; readonly names: readonly string[] | undefined; readonly hit: boolean }>();

/**
 * 「나를 멘션」 판정: 클라이언트 모델에 mention_user_ids가 없어(data 계층은 이 레인 밖) 본문의 `@내 이름` 토큰으로 본다(W-11d REPORT).
 */
function mentionsName(m: MessageItemData, name: string, names: readonly string[] | undefined): boolean {
  const cached = mentionCache.get(m);
  if (cached?.name === name && cached.names === names) return cached.hit;
  const hit = bodyMentionsName(m.body, name, names);
  mentionCache.set(m, { name, names, hit });
  return hit;
}

/** 「나를 멘션」(MessageItem `mentionsSelf`): 삭제·내가 쓴 메시지는 아니다. 본문 목록과 스레드가 같은 규칙(Codex r2 P2). */
function mentionsSelfOf(m: MessageItemData, selfName: string | undefined, selfId: string | undefined, names: readonly string[] | undefined): boolean {
  return selfName !== undefined && m.deleted !== true && (selfId === undefined || m.authorId !== selfId) && mentionsName(m, selfName, names);
}

/** G-52: 상대가 비활성화된 DM은 본문·답글 작성기 대신 안내를 둔다(서버는 이 DM 쓰기를 403으로 거절). */
function composerLocked(space: Space): boolean {
  return space.kind === 'dm' && space.peerInactiveName !== undefined;
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
  readonly onSend: (body: string, mentionUserIds?: readonly string[], attachmentIds?: readonly string[]) => void;
  /** 이미지 첨부 업로드(W-22, 본문 작성기만). 없으면 첨부 UI를 렌더하지 않는다. */
  readonly onUpload?: UploadFn;
  readonly onRetry: (clientMessageId: string) => void;
  readonly onDiscard: (clientMessageId: string) => void;
  readonly itemActions?: ItemActions;
  /** W-10j: 채널 나가기·다시 참여·멘션 후보(없으면 렌더하지 않음). */
  readonly membership?: MembershipProps;
  /** FR-BOT-11: 채널 헤더 봇 추가·제거(owner·채널·참여 중일 때만 호출자가 넘긴다). */
  readonly botControl?: BotChannelControlProps;
  /** FR-SYNC-03: 목록이 맨 아래(마지막 원문이 보임)일 때 그 seq를 알린다. */
  readonly onSeen?: (seq: number) => void;
  /** wide에서 스레드가 열려 있으면 헤더 오른쪽 패널 토글(시안 01)로 닫는다. */
  readonly onCloseThread?: () => void;
  /** 지금 열린 스레드의 루트 ID(시안 01 칩 강조). 닫혀 있으면 없음. */
  readonly openThreadRootId?: string;
  /** catch-up 중 — 「여기부터 새 메시지」 위치 계산 보류(UI_STATES §2-4). */
  readonly holding: boolean;
  /** 이 대화의 이력 조회가 끝났는가 — 끝난 뒤에 구분선 위치를 고정한다(Codex r2 P2). */
  readonly historyReady: boolean;
  /** 본문 `@이름` 토큰 근거(대화 멤버 이름)와 내 표시 이름(「나를 멘션」 판정). */
  readonly mentionNames?: readonly string[];
  readonly selfName?: string;
  /** 헤더 아래 안내(Jarvis DM 알림 1회 안내, W-23 ★Q-H4). */
  readonly notice?: ReactNode;
  /** R4 헤더 더보기 「키보드 단축키」(compact는 없음). */
  readonly onShortcuts?: () => void;
}) {
  const { space, roots, breakpoint, membership, onSeen } = props;
  const newSeq = useNewMessagesSeq(space.id, space.unreadCount, roots, props.holding, props.historyReady, props.itemActions?.selfId);
  const { mentionNames, selfName } = props;
  const selfId = props.itemActions?.selfId;
  const mentionsSelf = (m: Message) => mentionsSelfOf(m, selfName, selfId, mentionNames);
  const memberCount = space.kind === 'channel' ? (membership?.mentions?.candidates.length ?? 0) : 0;
  const left = space.left === true;
  const locked = composerLocked(space);
  const list = useRef<HTMLUListElement>(null);
  const pane = useRef<HTMLElement>(null);
  // G-52 경합: 작성기가 안내로 바뀌면 사라진 입력란의 포커스를 안내로(스레드와 같은 규칙).
  useFocusOnLock(locked, pane, () => pane.current?.querySelector<HTMLElement>('.composer-notice'));
  // a11y-focus-order: 실패 항목을 지우면 포커스를 본문 작성기(없으면 안내)로 — body로 떨어지지 않게.
  const onDiscard = withDiscardFocus(pane, props.onDiscard, MAIN_DISCARD_FOCUS);
  const onPinScroll = usePinBottom(list, space.id);
  // menu-bots-touch-focus: 봇 추가·제거는 머리 「대화 더보기」 메뉴 항목(머리 버튼 줄 없음 — 390도 한 줄).
  const botMenu = useBotChannelMenu(props.botControl, space.id);
  // focus-after-leave: 나가기 성공 뒤 사라진 「대화 더보기」 대신 머리 「다시 참여」로(BODY 유실 방지).
  const onLeave = useFocusAfterLeave(pane, space.id, left, membership?.onLeave);
  // UI_STATES §4-1 메시지 단위 roving tabindex(compact는 보이는 버튼이라 끈다).
  const roving = useMessageRoving(list, roots.map((m) => m.id));
  const rovingOn = breakpoint !== 'compact';
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
    <main ref={pane} className="conversation-pane" inert={props.inert}>
      <header className="conversation-header">
        {breakpoint === 'compact' && (
          // R4 모바일 시안: ‹ 아이콘(접근 이름 「뒤로」 그대로).
          <button type="button" className="icon-button conversation-back" aria-label="뒤로" title="뒤로" onClick={props.onBack}>
            <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false">
              <path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <div className="conversation-heading">
          <ConversationTitle space={space} />
          <span className="conversation-meta">
            {memberCount > 0 ? SHELL_COPY.channelMeta(memberCount) : SHELL_COPY.kind[space.kind]}
          </span>
        </div>
        <HeaderMenu
          {...(props.onShortcuts === undefined ? {} : { onShortcuts: props.onShortcuts })}
          {...(onLeave !== undefined && space.kind === 'channel' && !left ? { onLeave } : {})}
          bots={botMenu.items}
        />
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
      {botMenu.failure}
      {botMenu.dialog}
      {props.notice}
      {membership && left ? (
        <LeftChannelNotice onRejoin={membership.onRejoin} />
      ) : roots.length === 0 ? (
        <p className="message-empty">첫 메시지를 남겨 보세요</p>
      ) : (
        <ul
          ref={list}
          className="message-list"
          // 터치 기기에서 실패 항목을 지운 뒤 포커스 대상(MAIN_DISCARD_FOCUS — 작성기 대신). Tab 순서에는 들지 않는다.
          tabIndex={-1}
          onScroll={onListScroll}
          {...(rovingOn ? { onFocus: roving.onFocus, onKeyDown: roving.onKeyDown } : {})}
        >
          {roots.map((m, i) => (
            <Fragment key={m.id}>
              {startsNewDay(roots, i) && <DateSeparator at={m.createdAt} />}
              {newSeq !== null && m.seq === newSeq && <NewMessagesDivider />}
              <MessageItem
                message={m}
                onReply={props.onReply}
                onRetry={props.onRetry}
                onDiscard={onDiscard}
                retryLocked={locked}
                {...props.itemActions}
                threadUnread={space.unreadThreadRoots?.includes(m.id) === true}
                threadActive={m.id === props.openThreadRootId}
                timePlacement={breakpoint === 'compact' ? 'below' : 'inline'}
                mentionsSelf={mentionsSelf(m)}
                {...(mentionNames === undefined ? {} : { mentionNames })}
                {...(rovingOn ? { rovingActive: m.id === roving.activeId } : {})}
              />
            </Fragment>
          ))}
        </ul>
      )}
      {!left && locked && <ComposerNotice text={COMPOSER_COPY.inactivePeer} />}
      {!left && !locked && (
        <div data-composer="main">
          <Composer
            key={space.id}
            label={messageComposerLabel(spaceTitle(space))}
            placeholder={messagePlaceholder(space)}
            showHint={breakpoint !== 'compact'}
            mentionScope={space.kind}
            onSend={props.onSend}
            {...(props.onUpload === undefined ? {} : { onUpload: props.onUpload })}
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
  // 설치 프롬프트는 셸이 계속 붙잡는다 — 카드가 목록 화면에서만 마운트돼도 이벤트를 놓치지 않게(Codex r1 P2).
  const installPrompt = useInstallPrompt();
  const [state, dispatch] = useReducer(shellReducer, history, initialFrom);
  const [panel, setPanelState] = useState<PanelKind | null>(() => panelFrom(history));
  const [settings, setSettings] = useState(() => settingsFrom(history));
  const members = settings !== null;
  /** MemberAdmin 요청 함수(안정 참조 — 렌더마다 목록을 다시 읽지 않게). 구현이 없으면 403과 같게 본다. */
  const memberApi = useMemo(() => {
    const denied = { ok: false, status: 403 } as const;
    return {
      load: () => dataSource.listMembers?.() ?? Promise.resolve(denied),
      createInvite: () => dataSource.createInvite?.() ?? Promise.resolve(denied),
      deactivate: (id: string) => dataSource.deactivateMember?.(id) ?? Promise.resolve(denied),
    };
  }, [dataSource]);
  /** SessionList 요청 함수(안정 참조). */
  const sessionApi = useMemo(() => {
    const failed = { ok: false, status: 'network' } as const;
    return {
      load: () => dataSource.listSessions?.() ?? Promise.resolve(failed),
      revoke: (id: string) => dataSource.revokeSession?.(id) ?? Promise.resolve(failed),
      logoutThisDevice: () => void dataSource.logout?.(),
    };
  }, [dataSource]);
  const routed = useRef(false);
  const [announcement, setAnnouncement] = useState('');
  const shell = useRef<HTMLDivElement>(null);
  const prevThread = useRef<string | null>(null);
  const focusComposer = useRef(false);
  /** 같은 공간을 다시 골라도(전환기) 작성기 포커스 효과가 돌게 하는 카운터(F4). */
  const [focusTick, bumpFocus] = useReducer((n: number) => n + 1, 0);
  /** D §7-3 `Ctrl/⌘+K` 공간 전환기·`Ctrl/⌘+/` 단축키 안내. */
  const [overlay, setOverlay] = useState<'switcher' | 'shortcuts' | null>(null);

  const space = snap.spaces.find((s) => s.id === state.conversationId);
  /** 비동기 참여 완료 시점의 선택 대화(렌더 당시 값이 아니라 최신). */
  const selectedId = useRef(state.conversationId);
  useEffect(() => {
    selectedId.current = state.conversationId;
  }, [state.conversationId]);
  const pushEnv = useMemo(() => (dataSource.push ? browserPushEnv() : null), [dataSource.push]);
  const root = snap.messages.find((m) => m.id === state.threadRootId && m.conversationId === state.conversationId);
  // 나간 채널은 스레드도 닫힌 것으로 본다 — 답글 작성기로 나간 채널에 보내지 않게(Codex r1 P2).
  const threadOpen = space !== undefined && root !== undefined && space.left !== true;
  const bp = viewport.breakpoint;
  const autoCollapsed = isSidebarCollapsed(viewport, threadOpen);
  // R4 분할선(wide): 사용자 폭·접기. §5-2 자동 접힘이 우선.
  const split = useSplit(shell, { enabled: bp === 'wide', threadOpen, autoCollapsed, onCloseThread: () => dispatch({ type: 'close-thread' }) });
  const collapsed = autoCollapsed || split.userCollapsed;
  const historyReady = snap.loadedHistory === undefined || snap.loadedHistory === state.conversationId;
  // 알림 탭 `#message-:id` → 대상 메시지 스크롤·강조(W-23 Codex P2-3).
  const repliesReady = state.threadRootId === null || snap.loadedReplies === undefined || snap.loadedReplies.includes(state.threadRootId);
  const anchorNotice = useMessageAnchor({ history, shell, conversationId: state.conversationId, threadRootId: state.threadRootId, messages: snap.messages, historyReady, repliesReady, threadOpen });
  const anchorNoticeEl = (inThread: boolean) =>
    anchorNotice !== null && anchorNotice.inThread === inThread && (
      <p className="message-anchor-notice" role="status">
        {anchorNotice.text}
      </p>
    );

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
    const target = settings !== null
      ? formatRoute({ kind: settings })
      : formatRoute(state.conversationId === null ? { kind: 'root' } : { kind: 'conversation', conversationId: state.conversationId });
    const first = !routed.current;
    routed.current = true;
    // `/discover`·`/dm/new` 직접 진입은 패널 경로를 그대로 둔다.
    if (history.pathname() === target || (first && panelFrom(history) !== null)) return;
    if (first) history.replace(target);
    else history.push(target);
  }, [history, state.conversationId, settings]);

  // 뒤로·앞으로 → 선택 복원. 열린 공간 Dialog·화면은 닫는다.
  useEffect(
    () =>
      history?.listen(() => {
        const route = parseRoute(history.pathname());
        setPanelState(panelFrom(history));
        setSettings(settingsFrom(history));
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

  // F4: 공간 전환 후 새 공간의 작성기. menu-bots-touch-focus: 터치 기기는 가상 키보드가 화면을 가리므로 대화 제목으로.
  useEffect(() => {
    if (!focusComposer.current) return;
    focusComposer.current = false;
    if (prefersNoAutoKeyboard()) shell.current?.querySelector<HTMLElement>('.conversation-title')?.focus({ preventScroll: true });
    else shell.current?.querySelector<HTMLElement>('[data-composer="main"] textarea')?.focus();
  }, [state.conversationId, focusTick]);

  useGlobalShortcuts(bp !== 'compact', {
    onSwitcher: () => setOverlay('switcher'),
    onShortcuts: () => setOverlay('shortcuts'),
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (bp === 'compact' || !e.ctrlKey || !e.altKey) return;
    // 모달(Dialog·전환기·단축키 안내) 안의 키는 배경 공간을 바꾸지 않는다(Codex F-1 r1 P2).
    if ((e.target as HTMLElement).closest('[role="dialog"][aria-modal="true"]') !== null) return;
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
    setSettings(null);
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
  /** 생성·참여·DM 성공: 목록은 DataSource가 갱신을 시도했다(실패면 `pendingIds`로 알린다) → 패널 닫기 → 그 대화로 이동(구독은 `open` 효과가 기존 규칙으로). */
  const goTo = (conversationId: string) => {
    setPanel(null);
    setSettings(null);
    focusComposer.current = true;
    // 같은 대화(다시 참여)여도 F4 effect가 돌게 — conversationId가 그대로면 deps가 바뀌지 않는다.
    bumpFocus();
    dispatch({ type: 'select-space', conversationId });
    // 선택 중인 대화면 `open` effect가 다시 돌지 않는다 → 이력·구독을 직접 다시 연다(W-10j 다시 참여·QA D1 채널 찾기 참여).
    if (conversationId === selectedId.current) dataSource.open?.(conversationId);
  };
  /** W-10j 다시 참여: join 2xx → 그 대화로 이동 + 이력·구독 재개(`goTo`가 선택 중이면 직접 연다). */
  const rejoin = (conversationId: string) => {
    void dataSource.joinChannel?.(conversationId).then((res) => {
      if (res.ok) goTo(res.value);
    });
  };
  // 링크 함수는 대화·스레드가 바뀔 때만 새로 — memo(MessageItem) 얕은 비교를 깨지 않게(F-1).
  const spaceId = space?.id;
  const mainLink = useMemo(() => (spaceId === undefined ? undefined : messageLinkIn(spaceId, null)), [spaceId]);
  const threadLink = useMemo(
    () => (spaceId === undefined || state.threadRootId === null ? undefined : messageLinkIn(spaceId, state.threadRootId)),
    [spaceId, state.threadRootId],
  );
  // FR-BOT-11: 봇 추가·제거 성공 → 멤버 재조회(멤버 수·멘션 후보·컨트롤 상태가 같은 목록을 쓴다).
  const [memberRevision, bumpMembers] = useReducer((n: number) => n + 1, 0);
  // QA D1: 세션 중 비활성화(활성 목록에서 사라짐)도 같은 대화의 멤버를 다시 읽는다 — 두 카운터 모두 단조 증가라 합이 곧 재조회 신호.
  const conversationMembers = useConversationMembers(
    dataSource,
    space?.id ?? null,
    space !== undefined && space.left !== true,
    memberRevision + (snap.activeRevision ?? 0),
  );
  const mentionCandidates = conversationMembers.candidates;
  const manageBots = canManageChannelBots(snap.account, space) && dataSource.addBotToChannel !== undefined && dataSource.removeBotFromChannel !== undefined;
  const activeBots = useActiveBots(dataSource, manageBots);
  const memberIds = useMemo(() => new Set((mentionCandidates ?? []).map((c) => c.id)), [mentionCandidates]);
  const botControl: BotChannelControlProps | undefined =
    // 멤버 조회 실패를 「봇 미참여」로 읽지 않는다 — 2xx로 확인한 목록일 때만 보인다(Codex L3 P2).
    !manageBots || space === undefined || !conversationMembers.confirmed
      ? undefined
      : {
          bots: activeBots,
          memberIds,
          onAdd: async (botId) => {
            const res = (await dataSource.addBotToChannel?.(space.id, botId)) ?? { ok: false, status: 403 };
            if (res.ok) bumpMembers();
            return res;
          },
          onRemove: async (botId) => {
            const res = (await dataSource.removeBotFromChannel?.(space.id, botId)) ?? { ok: false, status: 403 };
            if (res.ok) bumpMembers();
            return res;
          },
        };
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
        setSettings(null);
        // compact는 선택 뒤 사이드바가 화면에서 사라진다 → F4 규칙으로 포커스를 옮긴다(BODY 유실 방지).
        // wide·medium은 사이드바가 남으므로 키보드 탐색 중인 포커스를 빼앗지 않는다.
        if (bp === 'compact') {
          focusComposer.current = true;
          bumpFocus();
        }
        dispatch({ type: 'select-space', conversationId: id });
      }}
      {...(snap.account === undefined ? {} : { account: snap.account })}
      {...(snap.listState === undefined ? {} : { listState: snap.listState })}
      {...(dataSource.discoverChannels && dataSource.joinChannel ? { onBrowseChannels: () => setPanel('browse') } : {})}
      {...(dataSource.listMembers && dataSource.startDm ? { onStartDm: () => setPanel('dm') } : {})}
      {...(dataSource.createChannel ? { onCreateChannel: () => setPanel('create') } : {})}
      {...(dataSource.reload ? { onRetryList: () => dataSource.reload?.() } : {})}
      {...(bp === 'compact' ? {} : { onOpenSwitcher: () => setOverlay('switcher') })}
      {...(split.toggleNav === undefined ? {} : { onToggleCollapse: split.toggleNav })}
      {...(dataSource.listMembers && dataSource.createInvite && dataSource.deactivateMember
        ? { onManageMembers: () => setSettings('members') }
        : {})}
      {...(dataSource.listSessions && dataSource.revokeSession ? { onManageSessions: () => setSettings('sessions') } : {})}
      {...(dataSource.logout ? { onLogout: () => void dataSource.logout?.() } : {})}
      {...(dataSource.joinChannel ? { onRejoin: rejoin } : {})}
      {...(pushEnv !== null && dataSource.push ? { pushSettings: <PushSettings env={pushEnv} server={dataSource.push} /> } : {})}
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
  const memberAdmin = settings !== null && (
    <div className="member-admin-screen">
      {bp === 'compact' && (
        <button type="button" className="btn btn-secondary" onClick={() => setSettings(null)}>
          {DIALOG_CLOSE_LABEL}
        </button>
      )}
      {settings === 'members' ? <MemberAdmin account={snap.account} {...memberApi} /> : <SessionList {...sessionApi} />}
    </div>
  );
  const pane = space && (
    <ConversationPane
      space={space}
      notice={
        <>
          {space.bot === true && pushEnv !== null && dataSource.push && <PushBotHint env={pushEnv} server={dataSource.push} />}
          {/* 스레드 대상 안내는 스레드가 닫혀 있을 때만 대화 화면에(열려 있으면 패널이 그린다). */}
          {anchorNoticeEl(false)}
          {!threadOpen && anchorNoticeEl(true)}
        </>
      }
      roots={snap.messages.filter((m) => m.conversationId === space.id && m.rootId === undefined)}
      breakpoint={bp}
      inert={bp === 'medium' && threadOpen}
      drafts={drafts}
      onBack={() => dispatch({ type: 'back' })}
      onReply={(id) => dispatch({ type: 'open-thread', rootId: id })}
      onSend={(body, mentionUserIds, attachmentIds) => dataSource.send({ conversationId: space.id }, body, mentionUserIds, attachmentIds)}
      {...(dataSource.uploadAttachment === undefined
        ? {}
        : {
            onUpload: (file: File, options?: UploadAttachmentOptions) =>
              dataSource.uploadAttachment?.(space.id, file, options) ?? Promise.resolve({ ok: false as const, status: 'network' as const }),
          })}
      onRetry={retry}
      onDiscard={discard}
      itemActions={{
        ...messageActions,
        onOpenThread: (id) => dispatch({ type: 'open-thread', rootId: id }),
        threadHolding: snap.connection === 'catching-up',
        ...(mainLink === undefined ? {} : { messageLink: mainLink }),
      }}
      {...(membership === undefined ? {} : { membership })}
      {...(botControl === undefined ? {} : { botControl })}
      onSeen={(seq) => dataSource.markRead?.(space.id, null, seq)}
      {...(bp === 'wide' && threadOpen ? { onCloseThread: closeThread } : {})}
      {...(threadOpen && state.threadRootId !== null ? { openThreadRootId: state.threadRootId } : {})}
      holding={snap.connection === 'catching-up'}
      historyReady={historyReady}
      {...(bp === 'compact' ? {} : { onShortcuts: () => setOverlay('shortcuts') })}
      {...(mentionNames === undefined ? {} : { mentionNames })}
      {...(snap.account === undefined ? {} : { selfName: snap.account.displayName })}
    />
  );
  // QA §4-2: 목록이 확정됐는데(로딩·catch-up 아님) 주소의 대화가 없으면 빈 화면 대신 안내(나간 채널 새로고침·삭제·오타).
  // 동작은 성공했지만 목록에서 아직 확인되지 않은 대화는 데이터 계층이 `pendingIds`로 알린다(Codex r1·r3 P2).
  const listSettled = (snap.listState ?? 'ready') === 'ready' && snap.connection !== 'catching-up';
  const unconfirmed = state.conversationId !== null && (snap.pendingIds ?? []).includes(state.conversationId);
  const missing = !members && space === undefined && state.conversationId !== null && listSettled && !unconfirmed && (
    <MissingConversation
      breakpoint={bp}
      // 숨은 `?thread=`가 복원돼 있어도 한 번에 목록으로(`back`은 스레드부터 닫는다 — Codex r1 P2).
      onBack={() => dispatch({ type: 'route', conversationId: null })}
      {...(dataSource.discoverChannels && dataSource.joinChannel ? { onBrowseChannels: () => setPanel('browse') } : {})}
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
      messageActions={threadLink === undefined ? messageActions : { ...messageActions, messageLink: threadLink }}
      onSeen={(seq) => dataSource.markRead?.(space.id, root.id, seq)}
      spaceTitle={spaceTitle(space)}
      notice={anchorNoticeEl(true)}
      {...(composerLocked(space) ? { composerNotice: COMPOSER_COPY.inactivePeer } : {})}
      {...(mentionNames === undefined ? {} : { mentionNames })}
      mentionsSelf={(m) => mentionsSelfOf(m, snap.account?.displayName, snap.account?.id, mentionNames)}
    />
  );
  // 시안 04: compact 공간 목록 위 설치 안내 카드(standalone·미지원이면 InstallCard가 렌더하지 않음).
  const compactScreen = (bp === 'compact' && spacePanel) || memberAdmin || thread || pane || missing || (
    <>
      <InstallCard mode={installPrompt.mode} onInstall={() => void installPrompt.install()} />
      {sidebar}
    </>
  );

  return (
    <div
      ref={shell}
      className="app-shell"
      data-layout={bp}
      data-sidebar={collapsed ? 'collapsed' : 'expanded'}
      data-thread={threadOpen && !members ? 'open' : 'closed'}
      data-split={bp === 'wide' ? 'on' : undefined}
      onKeyDown={onKeyDown}
    >
      <ConnectionBanner state={snap.connection} />
      {bp === 'compact' ? compactScreen : (
        <>
          {sidebar}
          {split.navSplitter}
          {memberAdmin || pane || missing}
          {!members && thread && split.threadSplitter}
          {!members && thread}
          {spacePanel}
          {overlay === 'switcher' && (
            <SpaceSwitcher
              spaces={snap.spaces}
              titleOf={spaceTitle}
              onClose={() => setOverlay(null)}
              onSelect={(id) => {
                setOverlay(null);
                goTo(id);
              }}
            />
          )}
          {overlay === 'shortcuts' && <ShortcutsDialog onClose={() => setOverlay(null)} />}
        </>
      )}
      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
