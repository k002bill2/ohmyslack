import type { AuthEvents } from '../auth/events.js';
import type { AuthService } from '../auth/service.js';
import type { ConversationEvents } from '../conversations/events.js';
import type { ConversationsService } from '../conversations/service.js';
import type { MessageChange, MessageDeleted, MessageEvents } from '../messages/events.js';
import { toView } from '../messages/index.js';
import type { MessageRecord } from '../messages/store.js';
import type { ReadEvents, ReadUpdated } from '../sync/events.js';
import type { SyncStore } from '../sync/store.js';
import { SYNC_LIMIT_MAX, WS_CLOSE_POLICY, type WsErrorCode, type WsServerFrame } from '../../shared.js';

/** 허브가 쓰는 소켓 최소 면(ws.WebSocket 호환). */
export interface HubSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface HubDeps {
  readonly auth: AuthService;
  readonly conversations: ConversationsService;
  readonly syncStore: SyncStore;
  readonly authEvents: AuthEvents;
  readonly conversationEvents: ConversationEvents;
  readonly messageEvents: MessageEvents;
  readonly readEvents: ReadEvents;
  readonly clock: () => number;
}

interface Subscription {
  /** replay 경계(ACK through_cursor). 이 값 이하의 live 변경은 replay가 이미 보냈다. */
  through: number;
}

interface Connection {
  readonly socket: HubSocket;
  readonly userId: string;
  readonly sessionId: string;
  readonly token: string;
  readonly subs: Map<string, Subscription>;
  /** 연결별 직렬 큐: replay·live·재확인이 비동기여도 전달 순서가 큐 순서와 같다. */
  queue: Promise<void>;
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
}

/** setTimeout 최대 지연(약 24.8일). 그보다 먼 만료는 중간에 깨어나 다시 계산한다. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface Hub {
  attach(socket: HubSocket, auth: { userId: string; sessionId: string; token: string; expiresAt: Date }): Connection;
  subscribe(conn: Connection, conversationId: string, afterCursor: number): void;
  unsubscribe(conn: Connection, conversationId: string): void;
  sendError(conn: Connection, code: WsErrorCode, retryable: boolean, conversationId?: string): void;
  detach(conn: Connection): void;
  /** 열린 연결 수(테스트·운영 관찰용). */
  size(): number;
  dispose(): void;
}

function messageFrame(kind: 'message.created' | 'message.updated', changeId: number, m: MessageRecord): WsServerFrame {
  return { type: kind, conversation_id: m.conversationId, change_id: changeId, message: toView(m) };
}

function deletedFrame(e: MessageDeleted): WsServerFrame {
  return {
    type: 'message.deleted',
    conversation_id: e.conversationId,
    change_id: e.changeId,
    message_id: e.messageId,
    seq: e.seq,
    deleted_at: e.deletedAt.toISOString(),
  };
}

/** replay 행(접힌 현재 상태)을 이벤트로: 삭제 → deleted(본문 없음), 수정됨 → updated, 그 외 created. */
function replayFrame(changeId: number, m: MessageRecord): WsServerFrame {
  if (m.deletedAt !== null) {
    return deletedFrame({ changeId, conversationId: m.conversationId, messageId: m.id, seq: m.seq, deletedAt: m.deletedAt });
  }
  return messageFrame(m.editedAt === null ? 'message.created' : 'message.updated', changeId, m);
}

/**
 * 메모리 연결 목록과 팬아웃(정본: TRD §4, §5, §5-1 S7, NC-09·NC-10). WS는 commit 후 알림만 담당하고
 * 진실의 원천은 DB다. 모든 전달 직전에 세션(비연장)·멤버십을 다시 확인한다.
 */
export function createHub(deps: HubDeps): Hub {
  const { auth, conversations, syncStore, clock } = deps;
  const conns = new Set<Connection>();

  const send = (conn: Connection, frame: WsServerFrame): void => {
    if (!conn.closed) conn.socket.send(JSON.stringify(frame));
  };

  const close = (conn: Connection, code: number, reason: string): void => {
    if (conn.closed) return;
    conn.closed = true;
    conns.delete(conn);
    if (conn.expiryTimer !== undefined) clearTimeout(conn.expiryTimer);
    conn.socket.close(code, reason);
  };

  const enqueue = (conn: Connection, task: () => Promise<void>): void => {
    conn.queue = conn.queue.then(async () => {
      if (conn.closed) return;
      try {
        await task();
      } catch {
        // 처리 실패는 연결을 신뢰할 수 없게 만든다: 클라이언트에 REST catch-up을 지시한다(B4).
        send(conn, { type: 'sync.required' });
      }
    });
  };

  /** 세션 유효(비연장 peek)면 true, 아니면 1008로 닫고 false. */
  const sessionAlive = async (conn: Connection): Promise<boolean> => {
    const found = await auth.peek(conn.token);
    if (found === undefined || found.session.id !== conn.sessionId) {
      close(conn, WS_CLOSE_POLICY, 'session_ended');
      return false;
    }
    return true;
  };

  const canRead = async (conn: Connection, conversationId: string): Promise<boolean> => {
    try {
      await conversations.assertAccess(conn.userId, conversationId, 'read');
      return true;
    } catch {
      return false;
    }
  };

  /** 팬아웃 직전 재확인(NC-09): 세션 → 멤버십. 멤버십이 끝났으면 구독을 닫는다. */
  const deliverable = async (conn: Connection, conversationId: string): Promise<boolean> => {
    if (!(await sessionAlive(conn))) return false;
    if (await canRead(conn, conversationId)) return true;
    endSubscription(conn, conversationId);
    return false;
  };

  const endSubscription = (conn: Connection, conversationId: string): void => {
    if (conn.subs.delete(conversationId)) send(conn, { type: 'error', code: 'not_found', retryable: false, conversation_id: conversationId });
  };

  const scheduleExpiry = (conn: Connection, expiresAt: Date): void => {
    const delay = Math.max(0, Math.min(MAX_TIMER_MS, expiresAt.getTime() - clock()));
    conn.expiryTimer = setTimeout(() => {
      conn.expiryTimer = undefined;
      // HTTP 요청이 세션을 연장했을 수 있으므로 DB 값으로 다시 판정한다(WS 자체는 연장하지 않는다, S7).
      void auth.peek(conn.token).then(
        (found) => {
          if (found === undefined || found.session.id !== conn.sessionId) close(conn, WS_CLOSE_POLICY, 'session_expired');
          else if (!conn.closed) scheduleExpiry(conn, found.session.expiresAt);
        },
        () => close(conn, WS_CLOSE_POLICY, 'session_expired'),
      );
    }, delay);
    conn.expiryTimer.unref?.();
  };

  const fanoutMessage = (conversationId: string, changeId: number, frame: () => WsServerFrame): void => {
    for (const conn of conns) {
      if (!conn.subs.has(conversationId)) continue;
      enqueue(conn, async () => {
        const sub = conn.subs.get(conversationId);
        if (sub === undefined || changeId <= sub.through) return;
        if (await deliverable(conn, conversationId)) send(conn, frame());
      });
    }
  };

  const onRead = (event: ReadUpdated): void => {
    for (const conn of conns) {
      if (conn.userId !== event.userId) continue;
      enqueue(conn, async () => {
        if (!(await sessionAlive(conn)) || !(await canRead(conn, event.conversationId))) return;
        send(conn, {
          type: 'read.updated',
          conversation_id: event.conversationId,
          thread_root_id: event.threadRootId,
          last_read_seq: event.lastReadSeq,
          updated_at: event.updatedAt.toISOString(),
        });
      });
    }
  };

  const unsubscribers = [
    deps.messageEvents.on('created', (e: MessageChange) =>
      fanoutMessage(e.message.conversationId, e.changeId, () => messageFrame('message.created', e.changeId, e.message)),
    ),
    deps.messageEvents.on('updated', (e: MessageChange) =>
      fanoutMessage(e.message.conversationId, e.changeId, () => messageFrame('message.updated', e.changeId, e.message)),
    ),
    deps.messageEvents.on('deleted', (e: MessageDeleted) => fanoutMessage(e.conversationId, e.changeId, () => deletedFrame(e))),
    deps.readEvents.onUpdated(onRead),
    deps.authEvents.onSessionRevoked((ids) => {
      const revoked = new Set(ids);
      for (const conn of [...conns]) if (revoked.has(conn.sessionId)) close(conn, WS_CLOSE_POLICY, 'session_revoked');
    }),
    deps.conversationEvents.onMembershipEnded((conversationId, userId) => {
      for (const conn of conns) if (conn.userId === userId) endSubscription(conn, conversationId);
    }),
  ];

  /**
   * 구독이 아직 이 replay의 것이고 멤버십이 유효한가. scan은 멤버십 조회와 본문 로딩이 별개 쿼리라 그 사이 나가기가
   * commit될 수 있다: 이벤트가 구독을 지웠거나(교체 포함) DB 재확인이 실패하면 false(Codex r1 P1, NC-09).
   */
  const replayStillValid = async (conn: Connection, conversationId: string, sub: Subscription): Promise<boolean> => {
    if (conn.closed || conn.subs.get(conversationId) !== sub) return false;
    if (await canRead(conn, conversationId)) return conn.subs.get(conversationId) === sub;
    endSubscription(conn, conversationId);
    return false;
  };

  /** `(after, through]` 구간에서 이 대화의 변경만 change_id 순으로 재생한다. 취소되면 false(ACK 금지). */
  const replay = async (conn: Connection, conversationId: string, sub: Subscription, after: number, through: number): Promise<boolean> => {
    let cursor = after;
    while (cursor < through) {
      const page = await syncStore.scan({ userId: conn.userId, after: cursor, through, limit: SYNC_LIMIT_MAX });
      if (!(await replayStillValid(conn, conversationId, sub))) return false;
      const mine = page.changes.filter((c) => c.message.conversationId === conversationId);
      for (const change of [...mine].sort((x, y) => x.changeId - y.changeId)) send(conn, replayFrame(change.changeId, change.message));
      if (page.scannedThrough <= cursor) break;
      cursor = page.scannedThrough;
    }
    return replayStillValid(conn, conversationId, sub);
  };

  return {
    attach(socket, info) {
      const conn: Connection = {
        socket,
        userId: info.userId,
        sessionId: info.sessionId,
        token: info.token,
        subs: new Map(),
        queue: Promise.resolve(),
        expiryTimer: undefined,
        closed: false,
      };
      conns.add(conn);
      scheduleExpiry(conn, info.expiresAt);
      // handshake peek와 attach 사이에 폐기·비활성화 이벤트가 지나갔을 수 있다: 붙은 직후 한 번 더 확인한다(S7 5초).
      enqueue(conn, async () => {
        await sessionAlive(conn);
      });
      return conn;
    },
    subscribe(conn, conversationId, afterCursor) {
      enqueue(conn, async () => {
        if (!(await sessionAlive(conn))) return;
        if (!(await canRead(conn, conversationId))) {
          send(conn, { type: 'error', code: 'not_found', retryable: false, conversation_id: conversationId });
          return;
        }
        // listener 먼저: 구독을 등록한 뒤 watermark를 읽는다. 이후 live는 큐에서 replay 뒤로 밀린다(TRD §4).
        const sub: Subscription = { through: Number.MAX_SAFE_INTEGER };
        conn.subs.set(conversationId, sub);
        try {
          const through = await syncStore.watermark();
          if (afterCursor > through || afterCursor < (await syncStore.retentionFloor(new Date(clock())))) {
            conn.subs.delete(conversationId);
            send(conn, { type: 'error', code: 'cursor_expired', retryable: false, conversation_id: conversationId });
            send(conn, { type: 'sync.required' });
            return;
          }
          if (!(await replay(conn, conversationId, sub, afterCursor, through))) return;
          sub.through = through;
          send(conn, { type: 'conversation.subscribed', conversation_id: conversationId, through_cursor: through });
        } catch (error) {
          // ACK 전 실패: through=MAX 항목이 남으면 live가 조용히 버려진다. 지우고 sync.required로 넘긴다(worker F2).
          if (conn.subs.get(conversationId) === sub) conn.subs.delete(conversationId);
          throw error;
        }
      });
    },
    unsubscribe(conn, conversationId) {
      enqueue(conn, async () => {
        conn.subs.delete(conversationId);
      });
    },
    sendError(conn, code, retryable, conversationId) {
      send(conn, { type: 'error', code, retryable, ...(conversationId === undefined ? {} : { conversation_id: conversationId }) });
    },
    detach(conn) {
      conn.closed = true;
      conns.delete(conn);
      if (conn.expiryTimer !== undefined) clearTimeout(conn.expiryTimer);
    },
    size: () => conns.size,
    dispose() {
      for (const off of unsubscribers) off();
      for (const conn of [...conns]) close(conn, 1001, 'server_shutdown');
    },
  };
}
