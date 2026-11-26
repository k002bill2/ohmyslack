import { HttpError } from '../../http/errors.js';
import { isAllowedPushEndpoint, PUSH_COALESCE_WINDOW_MS, PUSH_TTL_SECONDS, pushPayloadSchema, type PushPayload, type PushSubscriptionCreate } from '../../shared.js';
import type { MessageChange } from '../messages/events.js';
import type { OpsLogger } from '../ops/logger.js';
import type { PushConfig } from './config.js';
import type { PushContext, PushStore, PushTarget } from './repo.js';
import { topicOf, vapidDetailsOf, webPushSend, type PushSend } from './sender.js';

/** push 서비스(정본: TRD §6-2). 등록·해제와 메시지 생성 뒤 비동기 전송을 맡는다. */
export interface PushOptions {
  /** 미설정이면 push 비활성: vapid-public-key·구독 등록 404, 전송 0. */
  readonly config?: PushConfig;
  readonly send?: PushSend;
  /** 전송 작업 예약(기본 setImmediate). 테스트가 작업 실행 시점을 제어한다. */
  readonly schedule?: (task: () => void) => void;
}

export interface PushServiceDeps extends PushOptions {
  readonly store: PushStore;
  readonly logger: OpsLogger;
  readonly clock: () => number;
}

export interface PushService {
  readonly enabled: boolean;
  publicKey(): string;
  subscribe(userId: string, sessionId: string, input: PushSubscriptionCreate): Promise<string>;
  unsubscribe(userId: string, id: string): Promise<void>;
  /** 메시지 생성(커밋 후) 이벤트 → 예약만 하고 즉시 돌아온다. */
  onMessageCreated(event: MessageChange): void;
  onSessionsRevoked(sessionIds: readonly string[]): void;
  /** 예약된 전송이 모두 끝날 때까지 기다린다(테스트·종료용). */
  idle(): Promise<void>;
}

type Outcome = 'sent' | 'expired' | 'failed';

/**
 * ① Jarvis DM 새 원문 → 모든 멤버, Jarvis DM 답글 → 원문 작성자 ② 채널 최상위 봇 게시 → 채널 사람 멤버 전원,
 * 채널 스레드에서 봇이 단 답글 → 원문 작성자 ③ 멘션 대상. 사람이 채널에 쓴 글(최상위·답글)은 멘션만.
 * 작성자·봇 원문 작성자는 저장소 질의에서 제외한다.
 */
function recipientsOf(event: MessageChange, ctx: PushContext): { readonly everyone: boolean; readonly userIds: readonly string[] } {
  const message = event.message;
  const userIds = new Set<string>(message.mentionUserIds);
  const fromBot = message.authorKind === 'bot';
  const notifiesRootAuthor = ctx.botDm || fromBot;
  if (notifiesRootAuthor && message.threadRootId !== null && ctx.rootAuthorId !== null) userIds.add(ctx.rootAuthorId);
  userIds.delete(message.authorId);
  const everyone = message.threadRootId === null && (ctx.botDm || (ctx.channel && fromBot));
  return { everyone, userIds: [...userIds] };
}

/** 묶음 창(60초)이 지난 항목을 지운다 — 창 밖 항목은 판정에 쓰이지 않으므로 맵이 무한히 자라지 않게(W-23b). */
export function pruneCoalesce(lastSent: Map<string, number>, now: number, windowMs = PUSH_COALESCE_WINDOW_MS): void {
  for (const [key, at] of lastSent) if (now - at >= windowMs) lastSent.delete(key);
}

export function createPushService(deps: PushServiceDeps): PushService {
  const { store, logger, clock, config } = deps;
  const send = deps.send ?? webPushSend;
  const schedule = deps.schedule ?? ((task: () => void) => void setImmediate(task));
  /** (구독, 대화) → 마지막 전송 시각. 창 안의 후속 알림은 보내지 않는다. */
  const lastSent = new Map<string, number>();
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (work: () => Promise<void>): void => {
    const done = new Promise<void>((resolve) => {
      schedule(() => {
        work()
          .catch(() => logger.log({ event: 'push_send_error', error_code: 'push_job_failed' }))
          .finally(resolve);
      });
    });
    chain = chain.then(() => done);
  };

  const deliver = async (target: PushTarget, payload: string, conversationId: string, active: PushConfig): Promise<void> => {
    let outcome: Outcome = 'failed';
    let status = 0;
    try {
      status = await send({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload, {
        TTL: PUSH_TTL_SECONDS,
        topic: topicOf(conversationId),
        vapidDetails: vapidDetailsOf(active),
      });
      if (status >= 200 && status < 300) {
        outcome = 'sent';
        await store.markSuccess(target.id, new Date(clock()));
      } else if (status === 404 || status === 410) {
        outcome = 'expired';
        await store.deleteById(target.id);
      }
    } catch {
      outcome = 'failed';
    }
    // endpoint·키·payload는 싣지 않는다(허용 필드만: error_code=결과, status_code=응답 코드).
    logger.log({ event: 'push_send_result', error_code: outcome, status_code: status });
  };

  const notify = async (event: MessageChange, active: PushConfig): Promise<void> => {
    const message = event.message;
    if (message.deletedAt !== null) return;
    const ctx = await store.context(message.conversationId, message.threadRootId);
    const wanted = recipientsOf(event, ctx);
    if (!wanted.everyone && wanted.userIds.length === 0) return;
    const now = clock();
    const targets = await store.targets({
      conversationId: message.conversationId,
      messageId: message.id,
      threadRootId: message.threadRootId,
      seq: message.seq,
      everyone: wanted.everyone,
      userIds: wanted.userIds,
      authorId: message.authorId,
      keyId: active.keyId,
      now: new Date(now),
    });
    const payload: PushPayload = pushPayloadSchema.parse({
      v: 1,
      kind: 'message',
      conversation_id: message.conversationId,
      message_id: message.id,
      ...(message.threadRootId === null ? {} : { thread_root_id: message.threadRootId }),
      from_bot: message.authorKind === 'bot',
    });
    const body = JSON.stringify(payload);
    pruneCoalesce(lastSent, now);
    for (const target of targets) {
      if (target.userId === message.authorId) continue;
      const key = `${target.id}:${message.conversationId}`;
      const last = lastSent.get(key);
      if (last !== undefined && now - last < PUSH_COALESCE_WINDOW_MS) continue;
      // 전송은 대상별 순차라 그 사이 삭제될 수 있다 — 매 전송 직전 재확인, 삭제됐으면 남은 대상 모두 중단.
      // 묶음 맵은 실제 전송할 때만 갱신한다(건너뛴 대상이 60초 동안 막히지 않게).
      if (!(await store.isLive(message.id))) return;
      lastSent.set(key, now);
      await deliver(target, body, message.conversationId, active);
    }
  };

  return {
    enabled: config !== undefined,
    publicKey() {
      if (config === undefined) throw new HttpError(404, 'not_found');
      return config.publicKey;
    },
    async subscribe(userId, sessionId, input) {
      if (config === undefined) throw new HttpError(404, 'not_found');
      if (!isAllowedPushEndpoint(input.endpoint)) throw new HttpError(400, 'invalid_request');
      return store.upsert({ userId, sessionId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, keyId: config.keyId, at: new Date(clock()) });
    },
    async unsubscribe(userId, id) {
      if (!(await store.deleteOwn(id, userId))) throw new HttpError(404, 'not_found');
    },
    onMessageCreated(event) {
      const active = config;
      if (active === undefined) return;
      enqueue(() => notify(event, active));
    },
    onSessionsRevoked(sessionIds) {
      enqueue(() => store.deleteBySessions(sessionIds));
    },
    idle() {
      return chain;
    },
  };
}
