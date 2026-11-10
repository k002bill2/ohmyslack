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

/**
 * 허브가 쓰는 인증 면(사람 세션 또는 봇 토큰). `peek`은 비연장 확인, `session.id`는 연결 식별자(세션 ID·봇 토큰 ID)다.
 * 봇 리스너는 봇 토큰을 이 면으로 감싸 같은 허브(전달 재확인·멤버십·sweep)를 재사용한다(TRD §5-2 2·6항).
 */
export interface HubAuth {
  peek(token: string): Promise<{ readonly session: { readonly id: string; readonly expiresAt: Date } } | undefined>;
  liveSessionIds?: AuthService['liveSessionIds'];
}

export interface HubDeps {
  readonly auth: HubAuth;
  readonly conversations: ConversationsService;
  readonly syncStore: SyncStore;
  readonly authEvents: Pick<AuthEvents, 'onSessionRevoked'>;
  readonly conversationEvents: ConversationEvents;
  readonly messageEvents: MessageEvents;
  readonly readEvents: ReadEvents;
  readonly clock: () => number;
  /** sweep 주기(기본 SESSION_SWEEP_MS). 봇 리스너는 2초(TRD §5-2 2항 5초 보장 여유). */
  readonly sweepMs?: number;
  /** 인증이 끝나 닫을 때(sweep·재확인·폐기 이벤트)의 close 사유 고정값. 생략하면 사람 WS 사유(session_ended·session_revoked). */
  readonly endReason?: string;
  /**
   * 봇 허브 전용(BOT_CHANNEL_SPEC §4-3·§4-5). 있으면 replay·실시간 메시지 이벤트를 이 판정으로 거르고,
   * 멤버십 변화를 `membership.changed`로 그 사용자 연결에 보낸다. 사람 허브는 주지 않는다(동작 변화 0).
   */
  readonly botScope?: { visibleMessageIds(userId: string, messageIds: readonly string[]): Promise<ReadonlySet<string>> };
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

/**
 * 프로세스 밖 세션 폐기(reset-password CLI·수동 SQL·복원·DB 직접 비활성화)를 잡는 sweep 주기(F-2, NC-21, TRD §5-1 S4·S7).
 * 최악 지연 ≈ 주기 + 쿼리 2회 시간이므로 5초 보장을 위해 4초로 둔다.
 */
export const SESSION_SWEEP_MS = 4000;

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
  const sweepMs = deps.sweepMs ?? SESSION_SWEEP_MS;
  const sweepReason = deps.endReason ?? 'session_ended';
  const conns = new Set<Connection>();
  /** 대기 중인 다음 sweep(실행 중에는 undefined). 연결이 0이면 멈춘다. */
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;
  let sweeping = false;
  let disposed = false;

  const stopSweepIfIdle = (): void => {
    if (conns.size > 0 || sweepTimer === undefined) return;
    clearTimeout(sweepTimer);
    sweepTimer = undefined;
  };

  const send = (conn: Connection, frame: WsServerFrame): void => {
    if (!conn.closed) conn.socket.send(JSON.stringify(frame));
  };

  const close = (conn: Connection, code: number, reason: string): void => {
    if (conn.closed) return;
    conn.closed = true;
    conns.delete(conn);
    if (conn.expiryTimer !== undefined) clearTimeout(conn.expiryTimer);
    stopSweepIfIdle();
    conn.socket.close(code, reason);
  };

  /**
   * 열린 연결의 세션을 한 쿼리(세션 ID 배열, 비연장)로 다시 확인하고 무효면 1008로 닫는다. 조회 실패는 일시 장애로 보고
   * 아무것도 닫지 않는다 — 다음 주기에 다시 확인한다(전송 경로는 여전히 연결별 peek로 막힌다).
   */
  const sweep = async (): Promise<void> => {
    const targets = [...conns];
    if (targets.length === 0 || auth.liveSessionIds === undefined) return;
    let alive: ReadonlySet<string>;
    try {
      alive = await auth.liveSessionIds(targets.map((c) => c.sessionId));
    } catch {
      return;
    }
    for (const conn of targets) if (!alive.has(conn.sessionId)) close(conn, WS_CLOSE_POLICY, sweepReason);
  };

  /** 다음 sweep을 예약한다. 일괄 조회가 없거나 연결이 0이거나 이미 예약·실행 중이면 아무것도 하지 않는다. */
  const scheduleSweep = (): void => {
    if (disposed || sweeping || sweepTimer !== undefined || conns.size === 0 || auth.liveSessionIds === undefined) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = undefined;
      sweeping = true;
      void sweep().finally(() => {
        sweeping = false;
        scheduleSweep();
      });
    }, sweepMs);
    sweepTimer.unref?.();
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
      close(conn, WS_CLOSE_POLICY, sweepReason);
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

  /** 봇 허브면 가시성 판정을 통과한 메시지만(사람 허브는 항상 true). */
  const visibleTo = async (conn: Connection, messageId: string): Promise<boolean> =>
    deps.botScope === undefined || (await deps.botScope.visibleMessageIds(conn.userId, [messageId])).has(messageId);

  const fanoutMessage = (conversationId: string, changeId: number, messageId: string, frame: () => WsServerFrame): void => {
    for (const conn of conns) {
      if (!conn.subs.has(conversationId)) continue;
      enqueue(conn, async () => {
        const sub = conn.subs.get(conversationId);
        if (sub === undefined || changeId <= sub.through) return;
        if ((await deliverable(conn, conversationId)) && (await visibleTo(conn, messageId))) send(conn, frame());
      });
    }
  };

  const membershipFrame = (conversationId: string, userId: string, state: 'joined' | 'left'): void => {
    if (deps.botScope === undefined) return;
    for (const conn of conns) {
      if (conn.userId === userId) enqueue(conn, async () => send(conn, { type: 'membership.changed', conversation_id: conversationId, state }));
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
      fanoutMessage(e.message.conversationId, e.changeId, e.message.id, () => messageFrame('message.created', e.changeId, e.message)),
    ),
    deps.messageEvents.on('updated', (e: MessageChange) =>
      fanoutMessage(e.message.conversationId, e.changeId, e.message.id, () => messageFrame('message.updated', e.changeId, e.message)),
    ),
    deps.messageEvents.on('deleted', (e: MessageDeleted) => fanoutMessage(e.conversationId, e.changeId, e.messageId, () => deletedFrame(e))),
    deps.readEvents.onUpdated(onRead),
    deps.authEvents.onSessionRevoked((ids) => {
      const revoked = new Set(ids);
      for (const conn of [...conns]) if (revoked.has(conn.sessionId)) close(conn, WS_CLOSE_POLICY, deps.endReason ?? 'session_revoked');
    }),
    deps.conversationEvents.onMembershipEnded((conversationId, userId) => {
      for (const conn of conns) if (conn.userId === userId) endSubscription(conn, conversationId);
      membershipFrame(conversationId, userId, 'left');
    }),
    deps.conversationEvents.onMembershipStarted((conversationId, userId) => membershipFrame(conversationId, userId, 'joined')),
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
      const inConv = page.changes.filter((c) => c.message.conversationId === conversationId);
      const visible = deps.botScope === undefined ? undefined : await deps.botScope.visibleMessageIds(conn.userId, inConv.map((c) => c.message.id));
      const mine = visible === undefined ? inConv : inConv.filter((c) => visible.has(c.message.id));
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
      scheduleSweep();
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
      stopSweepIfIdle();
    },
    size: () => conns.size,
    dispose() {
      disposed = true;
      for (const off of unsubscribers) off();
      for (const conn of [...conns]) close(conn, 1001, 'server_shutdown');
      if (sweepTimer !== undefined) clearTimeout(sweepTimer);
      sweepTimer = undefined;
    },
  };
}
