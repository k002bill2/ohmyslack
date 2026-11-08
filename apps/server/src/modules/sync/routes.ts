import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { markAccountGuard, markConversationGuard } from '../../http/access.js';
import { HttpError } from '../../http/errors.js';
import {
  readStateRequestSchema,
  snapshotQuerySchema,
  syncQuerySchema,
  type ReadStateResponse,
  type SnapshotResponse,
  type SyncResponse,
} from '../../shared.js';
import { accountGuard, requireAuth } from '../auth/guards.js';
import type { AuthService } from '../auth/service.js';
import type { AccessAction, ConversationsService } from '../conversations/service.js';
import { toView } from '../messages/index.js';
import type { SyncService } from './service.js';

export interface SyncRouteDeps {
  readonly auth: AuthService;
  readonly conversations: ConversationsService;
  readonly sync: SyncService;
}

function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'invalid_request');
  return parsed.data;
}

const conversationRef = z.object({ conversation_id: z.uuid() });

/**
 * 경로 변수 대신 query·body의 `conversation_id`로 대화를 고르는 라우트(TRD §3 URL 고정)의 접근 가드.
 * `assertAccess` 하나로 판정하므로 표식을 붙인다(B2). 비참여자는 나머지 입력과 무관하게 404다.
 */
export function conversationRefGuard(
  service: ConversationsService,
  from: 'query' | 'body',
  action: AccessAction,
): preHandlerAsyncHookHandler {
  return markConversationGuard(async (request: FastifyRequest): Promise<void> => {
    request.conversationAccess = await service.assertAccess(requireAuth(request).user.id, conversationRefOf(request, from), action);
  });
}

/** query·body의 `conversation_id`(형식 오류 400). 봇 리스너의 같은 가드도 이 해석을 쓴다. */
export function conversationRefOf(request: FastifyRequest, from: 'query' | 'body'): string {
  const ref = conversationRef.safeParse(from === 'query' ? request.query : request.body);
  if (!ref.success) throw new HttpError(400, 'invalid_request');
  return ref.data.conversation_id;
}

/**
 * sync·snapshot·read-state 처리 본문(사람·봇 라우트 공용, TRD §5-2 6항 "같은 스키마·같은 서비스").
 * 행위자 id는 호출자가 인증 경계에서 정해 넘긴다 — 이 함수는 인증 정보를 읽지 않는다.
 */
export async function syncAs(service: SyncService, userId: string, rawQuery: unknown): Promise<SyncResponse> {
  const query = parseOr400(syncQuerySchema, rawQuery);
  const page = await service.sync(userId, query.after, query.through, query.limit);
  return {
    changes: page.changes.map((c) => ({ change_id: c.changeId, op: c.op, conversation_id: c.message.conversationId, message: toView(c.message) })),
    through_cursor: page.throughCursor,
    scanned_through: page.scannedThrough,
    has_more: page.hasMore,
    next_cursor: page.scannedThrough,
  };
}

/** 대화 접근은 호출자의 assertAccess 가드가 먼저 판정한다. */
export async function snapshotOf(service: SyncService, rawQuery: unknown): Promise<SnapshotResponse> {
  const query = parseOr400(snapshotQuerySchema, rawQuery);
  const page = await service.snapshot(query.conversation_id, query.before_seq, query.limit);
  return {
    snapshot_cursor: page.snapshotCursor,
    conversation_id: query.conversation_id,
    messages: page.messages.map(toView),
    has_more: page.hasMore,
    next_before_seq: page.hasMore ? (page.messages[0]?.seq ?? null) : null,
  };
}

/** 대화 접근은 호출자의 assertAccess 가드가 먼저 판정한다. */
export async function markReadAs(service: SyncService, userId: string, rawBody: unknown): Promise<ReadStateResponse> {
  const body = parseOr400(readStateRequestSchema, rawBody);
  const outcome = await service.markRead(userId, {
    conversationId: body.conversation_id,
    threadRootId: body.thread_root_id ?? null,
    lastReadSeq: body.last_read_seq,
  });
  return {
    conversation_id: outcome.conversationId,
    thread_root_id: outcome.threadRootId,
    last_read_seq: outcome.lastReadSeq,
    updated_at: outcome.updatedAt.toISOString(),
  };
}

const sync = (deps: SyncRouteDeps, request: FastifyRequest): Promise<SyncResponse> => syncAs(deps.sync, requireAuth(request).user.id, request.query);
const snapshot = (deps: SyncRouteDeps, request: FastifyRequest): Promise<SnapshotResponse> => snapshotOf(deps.sync, request.query);
const markRead = (deps: SyncRouteDeps, request: FastifyRequest): Promise<ReadStateResponse> =>
  markReadAs(deps.sync, requireAuth(request).user.id, request.body);

/**
 * 동기화·읽음 라우트(정본: TRD §3). `/api/sync`는 계정 전역(payload를 현재 멤버십으로 거른다).
 * snapshot·read-state는 URL이 경로 변수 없이 고정이라 `account` 메타지만, 표식 붙은 assertAccess 가드를 반드시 거친다.
 */
export function registerSyncRoutes(app: FastifyInstance, deps: SyncRouteDeps): void {
  const account = markAccountGuard(accountGuard(deps.auth));
  app.get('/api/sync', { config: { access: 'account' }, preHandler: account }, (request) => sync(deps, request));
  app.get(
    '/api/sync/snapshot',
    { config: { access: 'account' }, preHandler: [account, conversationRefGuard(deps.conversations, 'query', 'read')] },
    (request) => snapshot(deps, request),
  );
  app.put(
    '/api/read-state',
    { config: { access: 'account' }, preHandler: [account, conversationRefGuard(deps.conversations, 'body', 'read')] },
    (request) => markRead(deps, request),
  );
}
