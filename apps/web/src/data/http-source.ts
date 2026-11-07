/**
 * 운영 DataSource(W-10c): REST(TRD §3) + WS(TRD §4).
 * 복귀 순서: 인증(`GET /api/me`) → `GET /api/sync` 페이지 catch-up(410 → snapshot 절차) → `GET /api/conversations`
 * → 현재 대화 구독 ACK → 그때만 checkpoint 전진·「연결됨」(UI_STATES §5 C2). live 이벤트는 `change_id`로 멱등 병합하고
 * checkpoint를 움직이지 않는다. 401 → 화면 본문·checkpoint 삭제 후 세션 종료(S11).
 */
import type {
  ConversationsResponse,
  MeResponse,
  MembersResponse,
  MessageWriteResponse,
  SnapshotResponse,
  SyncResponse,
  WsServerFrame,
} from '../../../../packages/shared/src/index.js';
import { createSendController, type PendingMessage, type PostResult } from '../features/conversation';
import { adoptAccount, clearCheckpoints, readCheckpoint, writeCheckpoint, type SessionBus, type StorageLike } from '../features/sync';
import { createApi, HttpStatusError, NetworkError, type FetchLike } from './api.js';
import { emptyFold, foldDeleted, foldMessage, orderedMessages, type FoldState } from './fold.js';
import type { ConnectionState, DataSource, Message, Snapshot, Space } from './index.js';
import { createRealtimeClient, type SocketLike } from './realtime.js';

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

function toSpace(c: ConversationsResponse['conversations'][number], names: ReadonlyMap<string, string>): Space {
  const peer = c.peer_user_id === null ? undefined : names.get(c.peer_user_id);
  return {
    id: c.id,
    kind: c.kind,
    name: c.name ?? peer ?? '',
    unreadCount: c.unread_count,
    mentionCount: c.mention_count,
    unreadThreadCount: c.unread_thread_count,
  };
}

export function createHttpDataSource(deps: HttpDataSourceDeps): HttpDataSource {
  const storage = deps.storage === undefined ? undefined : deps.storage;
  const isOnline = deps.isOnline ?? (() => navigator.onLine);
  const listeners = new Set<() => void>();
  let snapshot: Snapshot = Object.freeze({ spaces: [], messages: [], connection: 'catching-up' as ConnectionState });
  let fold: FoldState = emptyFold;
  let spaces: readonly Space[] = [];
  let pending: readonly PendingMessage[] = [];
  let connection: ConnectionState = 'catching-up';
  let names: ReadonlyMap<string, string> = new Map();
  let userId: string | null = null;
  let checkpoint: number | null = null;
  let current: string | null = null;
  let generation = 0;
  let resuming = false;
  let ended = false;
  let failures = 0;
  const rootFor = new Map<string, string>();
  const acks = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  let nextRoot: string | undefined;
  let detach = () => undefined as void;

  const author = (id: string) => names.get(id) ?? id;

  const pendingAsMessage = (p: PendingMessage): Message => {
    const rootId = rootFor.get(p.clientMessageId);
    return {
      id: `pending:${p.clientMessageId}`,
      conversationId: p.conversationId,
      ...(rootId === undefined ? {} : { rootId }),
      author: author(userId ?? p.authorId),
      createdAt: '',
      body: p.body,
      replyCount: 0,
      pending: p,
    };
  };

  const emit = () => {
    const shown = pending.filter((p) => p.status !== 'confirmed').map(pendingAsMessage);
    snapshot = Object.freeze({ spaces, messages: [...orderedMessages(fold), ...shown], connection });
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
      try {
        const res = await api.post<MessageWriteResponse>(`/api/conversations/${encodeURIComponent(req.conversationId)}/messages`, {
          client_message_id: req.clientMessageId,
          body: req.body,
          ...(rootId === undefined ? {} : { thread_root_id: rootId }),
        });
        fold = foldMessage(fold, res.change_id, res.message, author);
        return { ok: true, messageId: res.message.id };
      } catch (e) {
        if (e instanceof HttpStatusError) return { ok: false, status: e.status };
        throw e;
      }
    },
    newClientMessageId: () => {
      const id = deps.newClientMessageId?.() ?? crypto.randomUUID();
      if (nextRoot !== undefined) rootFor.set(id, nextRoot);
      return id;
    },
    isOnline,
    onChange: (items) => {
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
        fold = foldMessage(fold, frame.change_id, frame.message, author);
        if (frame.type === 'message.created' && frame.message.author_id === userId) {
          const key = { conversationId: frame.conversation_id, authorId: '', clientMessageId: frame.message.client_message_id };
          sendController.messageCreated(key, frame.message.id);
        }
        emit();
        return;
      case 'message.deleted':
        fold = foldDeleted(fold, frame);
        emit();
        return;
      case 'sync.required':
        void resume();
        return;
      case 'error':
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
      // 1008: 세션 종료 가능성 — 다음 HTTP가 401이면 end()로 간다(UI_STATES C9).
      if (policy) void api.get('/api/me').catch(() => undefined);
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

  const foldChanges = (res: SyncResponse) => {
    for (const c of res.changes) fold = foldMessage(fold, c.change_id, c.message, author);
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

  const loadList = async () => {
    const list = await api.get<ConversationsResponse>('/api/conversations');
    spaces = list.conversations.map((c) => toSpace(c, names));
    return list.conversations;
  };

  /** 새 기기·410: 목록 → 대화별 snapshot → 첫 snapshot_cursor부터 catch-up(TRD §3). */
  const snapshotProcedure = async (): Promise<number> => {
    let first: number | null = null;
    for (const c of await loadList()) {
      const snap = await api.get<SnapshotResponse>(`/api/sync/snapshot?conversation_id=${encodeURIComponent(c.id)}`);
      first ??= snap.snapshot_cursor;
      for (const m of snap.messages) fold = foldMessage(fold, 0, m, author);
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
    adoptAccount(userId, storage);
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
    await loadMembers();
    if (gen !== generation) return false;
    emit();
    if (current !== null) {
      await waitOpen();
      await subscribe(current, watermark);
    }
    if (gen !== generation) return false;
    checkpoint = watermark;
    writeCheckpoint(userId, watermark, storage);
    failures = 0;
    setConnection('connected');
    return true;
  };

  const resume = async (): Promise<boolean> => {
    if (ended) return false;
    generation += 1;
    const gen = generation;
    resuming = true;
    setConnection(connection === 'offline' && !isOnline() ? 'offline' : 'catching-up');
    try {
      return await runResume(gen);
    } catch (e) {
      if (gen !== generation || ended) return false;
      // 서버 불가: 최신으로 표시하지 않는다. 네트워크 오류가 1회뿐이면 한 번 더 시도해 끊김 판정을 확정한다.
      if (e instanceof NetworkError && failures < OFFLINE_AFTER_FAILURES) return resume();
      return false;
    } finally {
      if (gen === generation) resuming = false;
    }
  };

  const loadHistory = async (conversationId: string) => {
    try {
      const res = await api.get<{ messages: SnapshotResponse['messages'] }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${HISTORY_LIMIT}`,
      );
      for (const m of res.messages) fold = foldMessage(fold, 0, m, author);
      emit();
    } catch (e) {
      if (!(e instanceof NetworkError) && !(e instanceof HttpStatusError)) throw e;
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(target, body) {
      nextRoot = target.rootId;
      void sendController.submit(target.conversationId, body);
      nextRoot = undefined;
    },
    open(conversationId) {
      if (ended || conversationId === current) return;
      if (current !== null) realtime.send({ type: 'conversation.unsubscribe', conversation_id: current });
      current = conversationId;
      if (conversationId === null) return;
      void loadHistory(conversationId);
      if (!resuming && checkpoint !== null) subscribe(conversationId, checkpoint).catch(() => undefined);
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
