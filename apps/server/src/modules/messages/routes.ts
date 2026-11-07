import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { markConversationGuard } from '../../http/access.js';
import { HttpError } from '../../http/errors.js';
import {
  historyQuerySchema,
  HISTORY_LIMIT_MAX,
  messageCreateRequestSchema,
  messageEditRequestSchema,
  repliesQuerySchema,
  type HistoryResponse,
  type MessageDeleteResponse,
  type MessageView,
  type MessageWriteResponse,
  type RepliesResponse,
} from '../../shared.js';
import { accountGuard, requireAuth } from '../auth/guards.js';
import type { AuthService } from '../auth/service.js';
import { conversationGuard } from '../conversations/routes.js';
import type { AccessAction, ConversationsService } from '../conversations/service.js';
import type { MessagesService, WriteOutcome } from './service.js';
import type { MessageRecord, PageRequest } from './store.js';

export interface MessageRouteDeps {
  readonly auth: AuthService;
  readonly conversations: ConversationsService;
  readonly messages: MessagesService;
}

const idParams = z.object({ id: z.uuid() });

function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'invalid_request');
  return parsed.data;
}

/** 형식이 틀린 ID도 "없는 대상"과 같은 404다(존재 은폐). */
function pathId(request: FastifyRequest): string {
  const parsed = idParams.safeParse(request.params);
  if (!parsed.success) throw new HttpError(404, 'not_found');
  return parsed.data.id;
}

/** `message` 메타 가드: 메시지 ID → 대화 해석 → assertAccess(B2). 표식이 없으면 레지스트리가 등록을 거부한다. */
export function messageGuard(messages: MessagesService, action: AccessAction): preHandlerAsyncHookHandler {
  return markConversationGuard(async (request: FastifyRequest): Promise<void> => {
    await messages.resolveAccess(requireAuth(request).user.id, pathId(request), action);
  });
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function toView(m: MessageRecord): MessageView {
  return {
    id: m.id,
    conversation_id: m.conversationId,
    seq: m.seq,
    author_id: m.authorId,
    client_message_id: m.clientMessageId,
    thread_root_id: m.threadRootId,
    body: m.body,
    created_at: m.createdAt.toISOString(),
    edited_at: iso(m.editedAt),
    deleted_at: iso(m.deletedAt),
    mention_user_ids: [...m.mentionUserIds],
    root_reply_count: m.rootReplyCount,
  };
}

function writeResponse(outcome: WriteOutcome): MessageWriteResponse {
  return { message: toView(outcome.message), seq: outcome.message.seq, change_id: outcome.changeId, mention_user_ids: [...outcome.message.mentionUserIds] };
}

interface PageQuery {
  readonly before_seq?: number | undefined;
  readonly after_seq?: number | undefined;
  readonly around_seq?: number | undefined;
  readonly limit?: number | undefined;
}

function pageRequest(q: PageQuery): PageRequest {
  return {
    limit: q.limit ?? HISTORY_LIMIT_MAX,
    ...(q.before_seq === undefined ? {} : { beforeSeq: q.before_seq }),
    ...(q.after_seq === undefined ? {} : { afterSeq: q.after_seq }),
    ...(q.around_seq === undefined ? {} : { aroundSeq: q.around_seq }),
  };
}

async function send(deps: MessageRouteDeps, request: FastifyRequest, reply: FastifyReply): Promise<MessageWriteResponse> {
  const body = parseOr400(messageCreateRequestSchema, request.body);
  const outcome = await deps.messages.send(requireAuth(request).user.id, pathId(request), {
    clientMessageId: body.client_message_id,
    body: body.body,
    threadRootId: body.thread_root_id ?? null,
    mentionUserIds: body.mention_user_ids ?? [],
  });
  reply.code(outcome.created ? 201 : 200);
  return writeResponse(outcome);
}

async function history(deps: MessageRouteDeps, request: FastifyRequest): Promise<HistoryResponse> {
  // roots_only는 계약상 받지만 이력은 항상 원문만 낸다(답글은 페이지 크기를 쓰지 않는다, FR-MSG-04·06).
  const query = parseOr400(historyQuerySchema, request.query);
  const page = await deps.messages.history(pathId(request), pageRequest(query));
  return { messages: page.messages.map(toView), has_more: page.hasMore };
}

async function replies(deps: MessageRouteDeps, request: FastifyRequest): Promise<RepliesResponse> {
  const query = parseOr400(repliesQuerySchema, request.query);
  const { root, page } = await deps.messages.replies(pathId(request), pageRequest(query));
  return { root: toView(root), replies: page.messages.map(toView), has_more: page.hasMore };
}

async function edit(deps: MessageRouteDeps, request: FastifyRequest): Promise<MessageWriteResponse> {
  const body = parseOr400(messageEditRequestSchema, request.body);
  return writeResponse(await deps.messages.edit(requireAuth(request).user.id, pathId(request), body.body, body.mention_user_ids ?? []));
}

async function remove(deps: MessageRouteDeps, request: FastifyRequest): Promise<MessageDeleteResponse> {
  const { message, changeId } = await deps.messages.remove(requireAuth(request).user.id, pathId(request));
  return { message_id: message.id, seq: message.seq, deleted_at: message.deletedAt?.toISOString() ?? '', change_id: changeId };
}

/** 메시지 라우트(정본: TRD §3, DEV_DESIGN §2-4). replies의 경로 변수는 TRD `{root_id}`와 같은 위치의 `:id`다. */
export function registerMessageRoutes(app: FastifyInstance, deps: MessageRouteDeps): void {
  const account = accountGuard(deps.auth);
  const inConversation = (action: AccessAction) => [account, conversationGuard(deps.conversations, action)];
  const onMessage = (action: AccessAction) => [account, messageGuard(deps.messages, action)];

  app.post('/api/conversations/:id/messages', { config: { access: 'conversation' }, preHandler: inConversation('write') }, (request, reply) =>
    send(deps, request, reply),
  );
  app.get('/api/conversations/:id/messages', { config: { access: 'conversation' }, preHandler: inConversation('read') }, (request) =>
    history(deps, request),
  );
  app.get('/api/messages/:id/replies', { config: { access: 'message' }, preHandler: onMessage('read') }, (request) => replies(deps, request));
  app.patch('/api/messages/:id', { config: { access: 'message' }, preHandler: onMessage('write') }, (request) => edit(deps, request));
  app.delete('/api/messages/:id', { config: { access: 'message' }, preHandler: onMessage('write') }, (request) => remove(deps, request));
}
