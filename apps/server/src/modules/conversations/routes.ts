import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { markConversationGuard } from '../../http/access.js';
import { HttpError } from '../../http/errors.js';
import {
  channelCreateRequestSchema,
  conversationsQuerySchema,
  discoverQuerySchema,
  dmCreateRequestSchema,
  DISCOVER_LIMIT_MAX,
  type ConversationMembersResponse,
  type ConversationRef,
  type ConversationsResponse,
  type DiscoverResponse,
} from '../../shared.js';
import { accountGuard, adminGuards, requireAuth } from '../auth/guards.js';
import type { AuthService } from '../auth/service.js';
import type { AccessAction, ConversationsService } from './service.js';
import type { AccessRow } from './store.js';

export interface ConversationRouteDeps {
  readonly auth: AuthService;
  readonly conversations: ConversationsService;
}

declare module 'fastify' {
  interface FastifyRequest {
    conversationAccess?: AccessRow;
  }
}

const idParams = z.object({ id: z.uuid() });

function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'invalid_request');
  return parsed.data;
}

function conversationId(request: FastifyRequest): string {
  const parsed = idParams.safeParse(request.params);
  // 형식이 틀린 ID도 "없는 대화"와 같은 응답이다(존재 은폐).
  if (!parsed.success) throw new HttpError(404, 'not_found');
  return parsed.data.id;
}

/**
 * `conversation` 메타 라우트의 접근 가드: 경로 `{id}`를 해석해 `assertAccess` 하나로 판정한다(B2).
 * 본문 검증은 처리기 안에서 하므로 비참여자는 입력과 무관하게 먼저 404를 받는다.
 */
export function conversationGuard(service: ConversationsService, action: AccessAction): preHandlerAsyncHookHandler {
  return markConversationGuard(async (request: FastifyRequest): Promise<void> => {
    request.conversationAccess = await service.assertAccess(requireAuth(request).user.id, conversationId(request), action);
  });
}

function access(request: FastifyRequest): AccessRow {
  if (request.conversationAccess === undefined) throw new HttpError(404, 'not_found');
  return request.conversationAccess;
}

async function listConversations(deps: ConversationRouteDeps, request: FastifyRequest): Promise<ConversationsResponse> {
  const query = parseOr400(conversationsQuerySchema, request.query);
  const limit = query.limit ?? DISCOVER_LIMIT_MAX;
  const fetched = await deps.conversations.store.listForUser(requireAuth(request).user.id, query.after, limit + 1);
  const rows = fetched.slice(0, limit);
  return {
    next_cursor: fetched.length > limit ? (rows.at(-1)?.id ?? null) : null,
    // unread·mention·스레드 집계는 같은 목록 쿼리에서 채운다(대화별 추가 호출 금지 계약).
    conversations: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      peer_user_id: r.peerUserId,
      last_seq: r.lastSeq,
      last_read_seq: r.lastReadSeq,
      unread_count: r.unread?.unreadCount ?? 0,
      mention_count: r.unread?.mentionCount ?? 0,
      unread_thread_count: r.unread?.threads.length ?? 0,
      unread_threads: (r.unread?.threads ?? []).map((t) => ({
        root_message_id: t.rootMessageId,
        last_read_seq: t.lastReadSeq,
        last_reply_seq: t.lastReplySeq,
        unread_reply_count: t.unreadReplyCount,
        mention_count: t.mentionCount,
      })),
    })),
  };
}

async function discover(deps: ConversationRouteDeps, request: FastifyRequest): Promise<DiscoverResponse> {
  const query = parseOr400(discoverQuerySchema, request.query);
  const limit = query.limit ?? DISCOVER_LIMIT_MAX;
  const rows = await deps.conversations.store.discover(requireAuth(request).user.id, query.after, limit + 1);
  const page = rows.slice(0, limit);
  return { channels: page.map((c) => ({ id: c.id, name: c.name })), next_cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
}

async function createChannel(deps: ConversationRouteDeps, request: FastifyRequest, reply: FastifyReply): Promise<ConversationRef> {
  const body = parseOr400(channelCreateRequestSchema, request.body);
  const created = await deps.conversations.createChannel(requireAuth(request).user.id, body.name);
  reply.code(201);
  return created;
}

async function openDm(deps: ConversationRouteDeps, request: FastifyRequest): Promise<ConversationRef> {
  const body = parseOr400(dmCreateRequestSchema, request.body);
  return deps.conversations.openDm(requireAuth(request).user.id, body.user_id);
}

/** 대화 공간 라우트(정본: TRD §3, DEV_DESIGN §2-4 access 메타). */
export function registerConversationRoutes(app: FastifyInstance, deps: ConversationRouteDeps): void {
  const account = accountGuard(deps.auth);
  const admin = [...adminGuards(deps.auth)];
  const guarded = (action: AccessAction) => [account, conversationGuard(deps.conversations, action)];

  app.get('/api/conversations', { config: { access: 'account' }, preHandler: account }, (request) => listConversations(deps, request));

  app.get('/api/conversations/discover', { config: { access: 'account' }, preHandler: account }, (request) => discover(deps, request));

  app.post('/api/conversations', { config: { access: 'admin' }, preHandler: admin }, (request, reply) => createChannel(deps, request, reply));

  app.post('/api/conversations/:id/join', { config: { access: 'conversation' }, preHandler: guarded('join') }, async (request) => {
    const id = conversationId(request);
    await deps.conversations.join(requireAuth(request).user.id, id);
    return { id };
  });

  app.delete('/api/conversations/:id/membership', { config: { access: 'conversation' }, preHandler: guarded('leave') }, async (request, reply) => {
    await deps.conversations.leave(requireAuth(request).user.id, conversationId(request), access(request));
    return reply.code(204).send();
  });

  app.get(
    '/api/conversations/:id/members',
    { config: { access: 'conversation' }, preHandler: guarded('read') },
    async (request): Promise<ConversationMembersResponse> => {
      const members = await deps.conversations.store.listMembers(conversationId(request));
      return { members: members.map((m) => ({ id: m.id, display_name: m.displayName })) };
    },
  );

  app.post('/api/dms', { config: { access: 'account' }, preHandler: account }, (request) => openDm(deps, request));
}
