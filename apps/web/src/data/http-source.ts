/**
 * 운영 DataSource(W-10c): REST(TRD §3) + WS(TRD §4).
 * 복귀 순서: 인증(`GET /api/me`) → `GET /api/sync` 페이지 catch-up(410 → snapshot 절차) → `GET /api/conversations`
 * → 현재 대화 구독 ACK → 그때만 checkpoint 전진·「연결됨」(UI_STATES §5 C2). live 이벤트는 `change_id`로 멱등 병합하고
 * checkpoint를 움직이지 않는다. 401 → 화면 본문·checkpoint 삭제 후 세션 종료(S11).
 */
import type {
  ConversationMembersResponse,
  ConversationRef,
  MessageDeleteResponse,
  ConversationsResponse,
  DiscoverResponse,
  MeResponse,
  MembersResponse,
  MessageView,
  MessageWriteResponse,
  RepliesResponse,
  SnapshotResponse,
  SyncResponse,
  WsServerFrame,
} from '../../../../packages/shared/src/index.js';
import { createSendController, type PendingMessage, type PostResult } from '../features/conversation';
import { adoptAccount, clearCheckpoints, readCheckpoint, writeCheckpoint, type SessionBus, type StorageLike } from '../features/sync';
import { createApi, HttpStatusError, NetworkError, type FetchLike } from './api.js';
import { emptyFold, foldDeleted, foldMessage, orderedMessages, type FoldState } from './fold.js';
import type { Account, ActionResult, ConnectionState, DataSource, ListState, Message, Snapshot, Space } from './index.js';
import { createRealtimeClient, type SocketLike } from './realtime.js';
import { probeMark } from '../measure/hook.js';

export interface HttpDataSourceDeps {
  readonly fetch: FetchLike;
  readonly createSocket: (url: string) => SocketLike;
  readonly wsUrl: string;
  readonly session: SessionBus;
  readonly storage?: StorageLike | null;
  readonly isOnline?: () => boolean;
  readonly newClientMessageId?: () => string;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** 전경 복귀(`visibilitychange`)·`online`/`offline` 이벤트 대상. 없으면 수동 resume만. */
  readonly lifecycle?: { readonly doc: EventTarget & { readonly visibilityState: string }; readonly win: EventTarget };
}

export interface HttpDataSource extends DataSource {
  /** 생명주기 이벤트를 걸고 첫 복귀 절차를 시작한다. */
  start(): Promise<boolean>;
  /** 복귀 절차 1회. 완료(연결됨)면 true, 실패·중단이면 false. */
  resume(): Promise<boolean>;
  retry(clientMessageId: string): Promise<void>;
  discard(clientMessageId: string): void;
  logout(): Promise<void>;
  stop(): void;
}

/** 끊김 판정: HTTP 네트워크 오류 연속 횟수(디자인 §6-4 제안값). */
const OFFLINE_AFTER_FAILURES = 2;
const HISTORY_LIMIT = 100;

type Summary = ConversationsResponse['conversations'][number];

/** 구독 거절(`error` 프레임에 대화 ID가 실린 경우). */
class SubscribeRejected extends Error {
  constructor(readonly code: string) {
    super('subscribe rejected');
  }
}

/** 읽음 위치 키: 대화 본문은 대화 ID, 스레드는 `대화:root`. */
const readKey = (conversationId: string, rootId: string | null) => (rootId === null ? conversationId : `${conversationId}:${rootId}`);

/**
 * 목록 항목 → Space. `reads`(WS `read.updated`로 받은 읽음 위치)와 서버 값을 단조 병합해 큰 쪽을 쓴다.
 * 병합한 위치가 마지막 seq에 닿으면 미읽음을 0으로, 스레드는 마지막 답글에 닿으면 미읽음 스레드에서 뺀다.
 */
function toSpace(c: Summary, names: ReadonlyMap<string, string>, reads: ReadonlyMap<string, number>): Space {
  const peer = c.peer_user_id === null ? undefined : names.get(c.peer_user_id);
  const read = Math.max(c.last_read_seq, reads.get(c.id) ?? 0);
  const caughtUp = read > c.last_read_seq && read >= c.last_seq;
  // mention_count는 본문·스레드 합산이라 로컬에서 줄이지 않는다 — read.updated 뒤 목록 재조회(서버 집계)를 따른다(Codex r1 P2).
  const threadsRead = c.unread_threads.filter((t) => {
    const r = Math.max(t.last_read_seq, reads.get(readKey(c.id, t.root_message_id)) ?? 0);
    return r > t.last_read_seq && r >= t.last_reply_seq;
  }).length;
  return {
    id: c.id,
    kind: c.kind,
    name: c.name ?? peer ?? '',
    unreadCount: caughtUp ? 0 : c.unread_count,
    mentionCount: c.mention_count,
    unreadThreadCount: Math.max(0, c.unread_thread_count - threadsRead),
    unreadThreadRoots: unreadRoots(c, reads),
  };
}

/** 새 답글이 남은 스레드 root id(CMP-14): `unread_reply_count > 0`이고 로컬 읽음 위치가 마지막 답글에 닿지 않은 것(W-10i). */
function unreadRoots(c: Summary, reads: ReadonlyMap<string, number>): readonly string[] {
  return c.unread_threads
    .filter((t) => t.unread_reply_count > 0 && (reads.get(readKey(c.id, t.root_message_id)) ?? 0) < t.last_reply_seq)
    .map((t) => t.root_message_id);
}

export function createHttpDataSource(deps: HttpDataSourceDeps): HttpDataSource {
  const storage = deps.storage === undefined ? undefined : deps.storage;
  const isOnline = deps.isOnline ?? (() => navigator.onLine);
  const listeners = new Set<() => void>();
  let snapshot: Snapshot = Object.freeze({ spaces: [], messages: [], connection: 'catching-up' as ConnectionState });
  let fold: FoldState = emptyFold;
  let spaces: readonly Space[] = [];
  let summaries: readonly Summary[] = [];
  /** 다른 기기 읽음 위치(단조 증가만). 목록을 다시 읽어도 뒤로 가지 않는다. */
  let reads: ReadonlyMap<string, number> = new Map();
  let pending: readonly PendingMessage[] = [];
  let connection: ConnectionState = 'catching-up';
  let account: Account | undefined;
  /** 목록이 한 번이라도 2xx로 왔는가 — 이후 실패는 목록을 유지하고 배너(연결 상태)로만 알린다. */
  let listState: ListState = 'loading';
  let names: ReadonlyMap<string, string> = new Map();
  let userId: string | null = null;
  let checkpoint: number | null = null;
  let current: string | null = null;
  let generation = 0;
  let resuming = false;
  let ended = false;
  let failures = 0;
  const rootFor = new Map<string, string>();
  /** 전송 대기 항목의 작성 시각(로컬). 빈 문자열이면 시각 포맷이 RangeError를 낸다(Codex r1 P1). */
  const createdFor = new Map<string, string>();
  const acks = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  let nextRoot: string | undefined;
  let nextMentions: readonly string[] | undefined;
  /** 전송 대기 항목의 멘션 ID(다시 시도도 같은 ID로 보낸다). */
  const mentionsFor = new Map<string, readonly string[]>();
  /** 이번 세션에 나간 채널(서버 목록은 `left_at IS NULL`만 준다 — REPORT 계약 부족). 다시 참여하면 지운다. */
  let leftChannels: ReadonlyMap<string, Space> = new Map();
  /** 목록 + 나간 채널(목록에 다시 나타나면 목록이 이긴다). */
  const withLeft = (list: readonly Space[]): readonly Space[] => {
    const ids = new Set(list.map((sp) => sp.id));
    // 다른 탭·기기에서 다시 참여해 서버 목록에 돌아온 채널은 나가기 기억에서도 지운다(Codex r1 P2).
    if ([...leftChannels.keys()].some((id) => ids.has(id))) {
      leftChannels = new Map([...leftChannels].filter(([id]) => !ids.has(id)));
    }
    return [...list, ...leftChannels.values()];
  };
  let detach = () => undefined as void;

  const author = (id: string) => names.get(id) ?? id;

  const pendingAsMessage = (p: PendingMessage): Message => {
    const rootId = rootFor.get(p.clientMessageId);
    return {
      id: `pending:${p.clientMessageId}`,
      conversationId: p.conversationId,
      ...(rootId === undefined ? {} : { rootId }),
      author: author(userId ?? p.authorId),
      createdAt: createdFor.get(p.clientMessageId) ?? new Date().toISOString(),
      body: p.body,
      replyCount: 0,
      pending: p,
    };
  };

  const emit = () => {
    const shown = pending.filter((p) => p.status !== 'confirmed').map(pendingAsMessage);
    snapshot = Object.freeze({
      spaces,
      messages: [...orderedMessages(fold), ...shown],
      connection,
      listState,
      ...(account === undefined ? {} : { account }),
    });
    listeners.forEach((l) => l());
  };

  const setConnection = (next: ConnectionState) => {
    if (connection === next) return;
    connection = next;
    emit();
  };

  /** 401·로그아웃: 화면 본문·대기 항목·checkpoint를 지우고 세션 종료를 알린다(S11, FR-CLIENT-04). */
  const end = (reason: 'unauthorized' | 'logout') => {
    if (ended) return;
    ended = true;
    generation += 1;
    realtime.stop();
    acks.forEach((a) => a.reject(new Error('ended')));
    acks.clear();
    detach();
    fold = emptyFold;
    spaces = [];
    summaries = [];
    leftChannels = new Map();
    reads = new Map();
    pending = [];
    checkpoint = null;
    clearCheckpoints(storage);
    emit();
    deps.session.end(reason);
  };

  const api = createApi({
    fetch: deps.fetch,
    onUnauthorized: () => end('unauthorized'),
    onNetwork: (ok) => {
      failures = ok ? 0 : failures + 1;
      if (failures >= OFFLINE_AFTER_FAILURES) setConnection('offline');
    },
  });

  const sendController = createSendController({
    me: '',
    post: async (req): Promise<PostResult> => {
      const rootId = rootFor.get(req.clientMessageId);
      const mentionIds = mentionsFor.get(req.clientMessageId);
      try {
        const res = await api.post<MessageWriteResponse>(`/api/conversations/${encodeURIComponent(req.conversationId)}/messages`, {
          client_message_id: req.clientMessageId,
          body: req.body,
          ...(rootId === undefined ? {} : { thread_root_id: rootId }),
          ...(mentionIds === undefined ? {} : { mention_user_ids: mentionIds }),
        });
        if (!ended) fold = foldMessage(fold, res.change_id, res.message, author);
        return { ok: true, messageId: res.message.id };
      } catch (e) {
        if (e instanceof HttpStatusError) return { ok: false, status: e.status };
        throw e;
      }
    },
    newClientMessageId: () => {
      const id = deps.newClientMessageId?.() ?? crypto.randomUUID();
      if (nextRoot !== undefined) rootFor.set(id, nextRoot);
      if (nextMentions !== undefined && nextMentions.length > 0) mentionsFor.set(id, nextMentions);
      createdFor.set(id, new Date().toISOString());
      return id;
    },
    isOnline,
    onChange: (items) => {
      // 세션 종료 뒤 늦게 끝난 전송이 본문을 되살리지 않는다(Codex r1 P2).
      if (ended) return;
      pending = items;
      emit();
    },
  });

  const subscribe = (conversationId: string, after: number): Promise<void> =>
    new Promise((resolve, reject) => {
      acks.get(conversationId)?.reject(new Error('superseded'));
      acks.set(conversationId, { resolve, reject });
      if (!realtime.send({ type: 'conversation.subscribe', conversation_id: conversationId, after_cursor: after })) {
        acks.delete(conversationId);
        reject(new Error('socket closed'));
      }
    });

  const onFrame = (frame: WsServerFrame) => {
    if (ended) return;
    switch (frame.type) {
      case 'conversation.subscribed':
        acks.get(frame.conversation_id)?.resolve();
        acks.delete(frame.conversation_id);
        return;
      case 'message.created':
      case 'message.updated':
        if (frame.type === 'message.created') probeMark('ws', frame.message.id, frame.message.created_at);
        fold = foldMessage(fold, frame.change_id, frame.message, author);
        if (frame.type === 'message.created' && frame.message.author_id === userId) {
          const key = { conversationId: frame.conversation_id, authorId: '', clientMessageId: frame.message.client_message_id };
          sendController.messageCreated(key, frame.message.id);
        }
        emit();
        if (frame.type === 'message.created') probeMark('emit', frame.message.id, frame.message.created_at);
        return;
      case 'message.deleted':
        fold = foldDeleted(fold, frame);
        emit();
        return;
      case 'sync.required':
        void resume();
        return;
      case 'read.updated':
        applyRead(frame.conversation_id, frame.thread_root_id, frame.last_read_seq);
        return;
      case 'error':
        // 대화 ID가 실린 오류는 그 대화의 구독 거절 — ACK 대기를 끝낸다(Codex r3 P2).
        if (frame.conversation_id !== undefined) {
          acks.get(frame.conversation_id)?.reject(new SubscribeRejected(frame.code));
          acks.delete(frame.conversation_id);
        }
        if (frame.code === 'cursor_expired') void resume();
        return;
      default:
        return;
    }
  };

  const realtime = createRealtimeClient({
    url: deps.wsUrl,
    createSocket: deps.createSocket,
    onFrame,
    onOpen: () => {
      if (!resuming && !ended) void resume();
      opened?.();
    },
    onClose: ({ policy }) => {
      acks.forEach((a) => a.reject(new Error('socket closed')));
      acks.clear();
      sendController.wsClosed();
      // 1008: 세션 종료 가능성 — 복귀 절차의 `GET /api/me`가 401이면 end(), 200이면 소켓 재연결·catch-up·구독(UI_STATES C9, Codex r3 P2).
      if (policy) void resume();
      else if (connection !== 'offline') setConnection('reconnecting');
    },
    ...(deps.setTimer === undefined ? {} : { setTimer: deps.setTimer }),
    ...(deps.clearTimer === undefined ? {} : { clearTimer: deps.clearTimer }),
  });

  let opened: (() => void) | null = null;
  const waitOpen = (): Promise<void> =>
    realtime.isOpen()
      ? Promise.resolve()
      : new Promise((resolve) => {
          opened = () => {
            opened = null;
            resolve();
          };
        });

  /** REST로 받은 내 메시지가 전송 대기(unknown) 항목과 같은 client_message_id면 확정한다(Codex r2 P2). */
  const confirmOwn = (m: MessageView) => {
    if (m.author_id !== userId) return;
    sendController.messageCreated({ conversationId: m.conversation_id, authorId: '', clientMessageId: m.client_message_id }, m.id);
  };

  const foldChanges = (res: SyncResponse) => {
    for (const c of res.changes) {
      fold = foldMessage(fold, c.change_id, c.message, author);
      confirmOwn(c.message);
    }
  };

  /** 페이지 catch-up. 첫 페이지 watermark(`through_cursor`)를 후속 페이지에 그대로 전달한다(TRD §3). */
  const catchUp = async (after: number): Promise<number> => {
    let res = await api.get<SyncResponse>(`/api/sync?after=${after}`);
    const through = res.through_cursor;
    foldChanges(res);
    while (res.has_more) {
      res = await api.get<SyncResponse>(`/api/sync?after=${res.next_cursor}&through=${through}`);
      foldChanges(res);
    }
    return through;
  };

  /** `next_cursor`가 null이 될 때까지 모든 페이지를 합친다(Codex r1 P2). */
  const loadList = async () => {
    let page = await api.get<ConversationsResponse>('/api/conversations');
    const all = [...page.conversations];
    while (page.next_cursor !== null) {
      page = await api.get<ConversationsResponse>(`/api/conversations?after=${encodeURIComponent(page.next_cursor)}`);
      all.push(...page.conversations);
    }
    // 세션 종료 뒤 늦게 도착한 목록 응답은 버린다(Codex r1 P2).
    if (ended) return [];
    summaries = all;
    spaces = withLeft(all.map((c) => toSpace(c, names, reads)));
    listState = 'ready';
    return all;
  };

  /** 거절된 대화를 현재 대화에서 내리고 목록을 다시 읽는다(접근 권한이 사라졌으면 목록에서도 빠진다). */
  const release = async (conversationId: string) => {
    if (current === conversationId) current = null;
    await loadList();
    if (!ended) emit();
  };

  /** WS `read.updated`: 읽음 위치를 단조 병합해 배지를 즉시 다시 계산하고, 멘션·부분 읽음은 서버 집계(목록 재조회)로 맞춘다. */
  const applyRead = (conversationId: string, rootId: string | null, seq: number) => {
    const key = readKey(conversationId, rootId);
    if (seq <= (reads.get(key) ?? 0)) return;
    reads = new Map(reads).set(key, seq);
    spaces = withLeft(summaries.map((c) => toSpace(c, names, reads)));
    emit();
    void loadList().then(
      () => {
        if (!ended) emit();
      },
      () => undefined,
    );
  };

  /** 새 기기·410: 목록 → 대화별 snapshot → 첫 snapshot_cursor부터 catch-up(TRD §3). */
  const snapshotProcedure = async (): Promise<number> => {
    // snapshot이 정본: 만료 기간의 수정·삭제가 이전 applied change_id에 막혀 무시되지 않도록 fold를 새로 쌓는다(Codex r1 P1).
    fold = emptyFold;
    let first: number | null = null;
    for (const c of await loadList()) {
      const snap = await api.get<SnapshotResponse>(`/api/sync/snapshot?conversation_id=${encodeURIComponent(c.id)}`);
      first ??= snap.snapshot_cursor;
      for (const m of snap.messages) {
        fold = foldMessage(fold, 0, m, author);
        confirmOwn(m);
      }
    }
    return catchUp(first ?? 0);
  };

  const loadMembers = async () => {
    try {
      const res = await api.get<MembersResponse>('/api/members');
      names = new Map([...names, ...res.members.map((m) => [m.id, m.display_name] as const)]);
    } catch (e) {
      if (!(e instanceof NetworkError) && !(e instanceof HttpStatusError)) throw e;
    }
  };

  const runResume = async (gen: number): Promise<boolean> => {
    const me = await api.get<MeResponse>('/api/me');
    if (gen !== generation) return false;
    api.setCsrf(me.csrf_token);
    userId = me.user.id;
    names = new Map(names).set(me.user.id, me.user.display_name);
    account = { id: me.user.id, displayName: me.user.display_name, role: me.user.role };
    adoptAccount(userId, storage);
    // 이름이 먼저 있어야 catch-up·snapshot 메시지 작성자와 DM 이름이 UUID·빈 값으로 굳지 않는다(Codex r1 P2).
    await loadMembers();
    if (gen !== generation) return false;
    realtime.start();
    const saved = readCheckpoint(userId, storage);
    let watermark: number;
    try {
      watermark = saved === null ? await snapshotProcedure() : await catchUp(saved);
    } catch (e) {
      if (!(e instanceof HttpStatusError) || e.status !== 410) throw e;
      watermark = await snapshotProcedure();
    }
    await loadList();
    if (gen !== generation) return false;
    emit();
    // 복귀 중 대화가 바뀌었으면 바뀐 대화를 다시 구독한다 — 현재 대화의 ACK 뒤에만 연결됨·checkpoint 전진(Codex r2 P2).
    for (let target = current; target !== null; target = current) {
      await waitOpen();
      try {
        await subscribe(target, watermark);
      } catch (e) {
        // 접근 거절(not_found)만 현재 대화를 내린다. cursor_expired 등은 프레임 처리가 시작한 복귀 절차가 재구독한다(Codex r1 P2).
        if (!(e instanceof SubscribeRejected) || e.code !== 'not_found') throw e;
        if (gen !== generation) return false;
        await release(target);
        continue;
      }
      if (gen !== generation) return false;
      if (current === target) break;
    }
    if (gen !== generation) return false;
    checkpoint = watermark;
    writeCheckpoint(userId, watermark, storage);
    failures = 0;
    setConnection('connected');
    return true;
  };

  const resume = async (retried = false): Promise<boolean> => {
    if (ended) return false;
    generation += 1;
    const gen = generation;
    resuming = true;
    setConnection(connection === 'offline' && !isOnline() ? 'offline' : 'catching-up');
    try {
      return await runResume(gen);
    } catch (e) {
      if (gen !== generation || ended) return false;
      // 목록을 아직 한 번도 받지 못했으면 사이드바 오류 상태(UI_STATES §2-3 「오류」 + 「다시 시도」).
      if (listState !== 'ready' && (!(e instanceof NetworkError) || retried)) {
        listState = 'error';
        emit();
      }
      // 서버 불가: 최신으로 표시하지 않는다. 네트워크 오류가 1회뿐이면 한 번 더 시도해 끊김 판정을 확정한다.
      // 재시도는 복귀 절차당 1회 — 중간 HTTP 성공이 실패 횟수를 초기화해도 무한 재호출하지 않는다(Codex r1 P2).
      if (e instanceof NetworkError && !retried) return resume(true);
      if (e instanceof NetworkError) setConnection('offline');
      return false;
    } finally {
      if (gen === generation) resuming = false;
    }
  };

  const loadHistory = async (conversationId: string) => {
    try {
      const res = await api.get<{ messages: SnapshotResponse['messages'] }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${HISTORY_LIMIT}&roots_only=true`,
      );
      if (ended) return;
      for (const m of res.messages) fold = foldMessage(fold, 0, m, author);
      emit();
    } catch (e) {
      if (!(e instanceof NetworkError) && !(e instanceof HttpStatusError)) throw e;
    }
  };

  /** 스레드 기존 답글: `after_seq`로 오름차순 페이지를 끝까지 읽는다(TRD §3 replies, Codex r2 P1). */
  const loadReplies = async (rootId: string) => {
    const path = `/api/messages/${encodeURIComponent(rootId)}/replies`;
    try {
      let after = 0;
      for (;;) {
        const res = await api.get<RepliesResponse>(`${path}?after_seq=${after}&limit=${HISTORY_LIMIT}`);
        if (ended) return;
        fold = foldMessage(fold, 0, res.root, author);
        for (const m of res.replies) fold = foldMessage(fold, 0, m, author);
        emit();
        const last = res.replies.at(-1);
        if (!res.has_more || last === undefined) return;
        after = last.seq;
      }
    } catch (e) {
      if (!(e instanceof NetworkError) && !(e instanceof HttpStatusError)) throw e;
    }
  };

  /** 요청 실패를 ActionResult로. 401은 api가 이미 세션 종료를 처리했다. */
  const attempt = async <T>(run: () => Promise<T>): Promise<ActionResult<T>> => {
    try {
      return { ok: true, value: await run() };
    } catch (e) {
      if (e instanceof NetworkError) return { ok: false, status: 'network' };
      if (e instanceof HttpStatusError) return e.code === undefined ? { ok: false, status: e.status } : { ok: false, status: e.status, code: e.code };
      throw e;
    }
  };

  /** 생성·참여·DM 성공 뒤: 목록 갱신 → 화면 반영. 이동·구독은 호출자의 `open(id)`이 기존 규칙으로 한다. */
  const refreshThen = async (id: string): Promise<string> => {
    // 생성·참여·DM은 이미 성공했다 — 목록 조회 실패를 동작 실패로 돌려주면 재제출이 409가 된다(Codex r1 P2).
    // 목록은 다음 복귀 절차가 다시 읽는다. 401은 api가 세션을 이미 끝냈다.
    try {
      await loadList();
    } catch (e) {
      if (!(e instanceof NetworkError) && !(e instanceof HttpStatusError)) throw e;
    }
    if (!ended) emit();
    return id;
  };

  return {
    getSnapshot: () => snapshot,
    createChannel: (name) =>
      attempt(async () => refreshThen((await api.post<ConversationRef>('/api/conversations', { kind: 'channel', name })).id)),
    discoverChannels: () =>
      attempt(async () => {
        let page = await api.get<DiscoverResponse>('/api/conversations/discover');
        const all = [...page.channels];
        while (page.next_cursor !== null) {
          page = await api.get<DiscoverResponse>(`/api/conversations/discover?after=${encodeURIComponent(page.next_cursor)}`);
          all.push(...page.channels);
        }
        return all;
      }),
    joinChannel: (conversationId) =>
      attempt(async () => {
        const ref = await api.post<ConversationRef>(`/api/conversations/${encodeURIComponent(conversationId)}/join`);
        const next = new Map(leftChannels);
        next.delete(conversationId);
        leftChannels = next;
        return refreshThen(ref.id);
      }),
    leaveChannel: (conversationId) =>
      attempt(async () => {
        await api.del<undefined>(`/api/conversations/${encodeURIComponent(conversationId)}/membership`);
        const space = spaces.find((sp) => sp.id === conversationId);
        if (space !== undefined) leftChannels = new Map(leftChannels).set(conversationId, { ...space, left: true, unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 });
        // 구독 해제: 현재 대화면 내린다 — 다시 참여 후 `open(id)`이 이력·구독을 다시 연다.
        if (current === conversationId) {
          realtime.send({ type: 'conversation.unsubscribe', conversation_id: conversationId });
          acks.get(conversationId)?.reject(new Error('left'));
          acks.delete(conversationId);
          current = null;
        }
        // 목록 재조회가 실패해도 나간 상태는 바로 보인다(Codex r1 P2).
        spaces = withLeft(spaces.filter((sp) => sp.id !== conversationId));
        emit();
        await refreshThen(conversationId);
        return null;
      }),
    listConversationMembers: (conversationId) =>
      attempt(async () => {
        const res = await api.get<ConversationMembersResponse>(`/api/conversations/${encodeURIComponent(conversationId)}/members`);
        return res.members.map((m) => ({ id: m.id, displayName: m.display_name }));
      }),
    listMembers: () =>
      attempt(async () => {
        const res = await api.get<MembersResponse>('/api/members');
        names = new Map([...names, ...res.members.map((m) => [m.id, m.display_name] as const)]);
        return res.members.map((m) => ({ id: m.id, displayName: m.display_name, role: m.role }));
      }),
    createInvite: () =>
      attempt(async () => {
        const res = await api.post<{ id: string; token: string; expires_at: string }>('/api/invites');
        return { id: res.id, token: res.token, expiresAt: res.expires_at };
      }),
    deactivateMember: (userId) =>
      attempt(async () => {
        await api.post<undefined>(`/api/admin/members/${encodeURIComponent(userId)}/deactivate`);
        return null;
      }),
    startDm: (userId) => attempt(async () => refreshThen((await api.post<ConversationRef>('/api/dms', { user_id: userId })).id)),
    reload: () => {
      if (listState === 'error') {
        listState = 'loading';
        emit();
      }
      void resume();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(target, body, mentionUserIds) {
      nextRoot = target.rootId;
      nextMentions = mentionUserIds;
      void sendController.submit(target.conversationId, body);
      nextRoot = undefined;
      nextMentions = undefined;
    },
    open(conversationId) {
      if (ended || conversationId === current) return;
      if (current !== null) realtime.send({ type: 'conversation.unsubscribe', conversation_id: current });
      // 나간 채널은 구독·이력을 열지 않는다(구독은 서버가 거절한다) — 다시 참여 뒤 `open(id)`이 연다.
      current = conversationId !== null && leftChannels.has(conversationId) ? null : conversationId;
      if (current === null || conversationId === null) return;
      void loadHistory(conversationId);
      if (!resuming && checkpoint !== null) {
        subscribe(conversationId, checkpoint).catch((e: unknown) => {
          if (e instanceof SubscribeRejected && e.code === 'not_found' && !ended) void release(conversationId).catch(() => undefined);
        });
      }
    },
    openThread(rootId) {
      if (ended || rootId === null) return;
      void loadReplies(rootId);
    },
    start() {
      const life = deps.lifecycle;
      if (life !== undefined) {
        // 전경 복귀는 WS가 살아 있어도 항상 catch-up(UI_STATES C8, DD R-03) — 5분 이상 백그라운드 복귀를 포함한다.
        const onVisible = () => {
          if (life.doc.visibilityState === 'visible') void resume();
        };
        const onOnline = () => void resume();
        const onOffline = () => setConnection('offline');
        life.doc.addEventListener('visibilitychange', onVisible);
        life.win.addEventListener('online', onOnline);
        life.win.addEventListener('offline', onOffline);
        detach = () => {
          life.doc.removeEventListener('visibilitychange', onVisible);
          life.win.removeEventListener('online', onOnline);
          life.win.removeEventListener('offline', onOffline);
        };
      }
      return resume();
    },
    resume,
    editMessage: (messageId, body) =>
      attempt(async () => {
        const res = await api.patch<MessageWriteResponse>(`/api/messages/${encodeURIComponent(messageId)}`, { body });
        if (!ended) {
          fold = foldMessage(fold, res.change_id, res.message, author);
          emit();
        }
        return null;
      }),
    deleteMessage: (messageId) =>
      attempt(async () => {
        const res = await api.del<MessageDeleteResponse>(`/api/messages/${encodeURIComponent(messageId)}`);
        if (!ended) {
          fold = foldDeleted(fold, res);
          emit();
        }
        return null;
      }),
    retry: (clientMessageId) => sendController.retry(clientMessageId),
    discard: (clientMessageId) => sendController.discard(clientMessageId),
    async logout() {
      try {
        await api.post('/api/auth/logout');
      } finally {
        end('logout');
      }
    },
    stop() {
      detach();
      generation += 1;
      realtime.stop();
    },
  };
}
