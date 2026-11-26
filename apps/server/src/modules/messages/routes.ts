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
  type MessagePreviewResponse,
  type MessageView,
  type MessageWriteResponse,
  type RepliesResponse,
  isAttachmentFileMime,
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
    author_kind: m.authorKind,
    client_message_id: m.clientMessageId,
    thread_root_id: m.threadRootId,
    body: m.body,
    created_at: m.createdAt.toISOString(),
    edited_at: iso(m.editedAt),
    deleted_at: iso(m.deletedAt),
    mention_user_ids: [...m.mentionUserIds],
    root_reply_count: m.rootReplyCount,
    attachments: (m.attachments ?? []).map((a) => ({
      id: a.id,
      mime: a.mime,
      byte_size: a.byteSize,
      duration_ms: a.durationMs,
      width: a.width,
      height: a.height,
      // 문서·텍스트 계열만 filename·has_macros를 싣는다(미디어 projection은 기존 모양 유지, TRD §6-1-1 (5)).
      ...(isAttachmentFileMime(a.mime) ? { filename: a.filename, has_macros: a.hasMacros } : {}),
      expires_at: a.expiresAt.toISOString(),
      expired: a.expired,
    })),
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

/**
 * 메시지 처리 본문(사람·봇 라우트 공용, TRD §5-2 6항 "같은 스키마·같은 서비스"). 행위자 id는 호출자가 인증 경계에서 정해 넘긴다.
 * 대화·메시지 접근은 호출자의 assertAccess 가드가 먼저 판정한다.
 */
export async function sendAs(messages: MessagesService, authorId: string, conversationId: string, rawBody: unknown, reply: FastifyReply): Promise<MessageWriteResponse> {
  const body = parseOr400(messageCreateRequestSchema, rawBody);
  const outcome = await messages.send(authorId, conversationId, {
    clientMessageId: body.client_message_id,
    body: body.body,
    threadRootId: body.thread_root_id ?? null,
    mentionUserIds: body.mention_user_ids ?? [],
    // UUID는 대소문자 무관 — PostgreSQL이 소문자로 돌려주므로 결속·멱등 비교 전에 소문자로 맞춘다(Codex r1 P2).
    attachmentIds: (body.attachment_ids ?? []).map((id) => id.toLowerCase()),
  });
  reply.code(outcome.created ? 201 : 200);
  return writeResponse(outcome);
}

export async function historyOf(messages: MessagesService, conversationId: string, rawQuery: unknown): Promise<HistoryResponse> {
  // roots_only는 계약상 받지만 이력은 항상 원문만 낸다(답글은 페이지 크기를 쓰지 않는다, FR-MSG-04·06).
  const query = parseOr400(historyQuerySchema, rawQuery);
  const page = await messages.history(conversationId, pageRequest(query));
  return { messages: page.messages.map(toView), has_more: page.hasMore };
}

export async function repliesOf(messages: MessagesService, rootId: string, rawQuery: unknown): Promise<RepliesResponse> {
  const query = parseOr400(repliesQuerySchema, rawQuery);
  const { root, page } = await messages.replies(rootId, pageRequest(query));
  return { root: toView(root), replies: page.messages.map(toView), has_more: page.hasMore };
}

export async function editAs(messages: MessagesService, editorId: string, messageId: string, rawBody: unknown): Promise<MessageWriteResponse> {
  const body = parseOr400(messageEditRequestSchema, rawBody);
  return writeResponse(await messages.edit(editorId, messageId, body.body, body.mention_user_ids ?? []));
}

const send = (deps: MessageRouteDeps, request: FastifyRequest, reply: FastifyReply): Promise<MessageWriteResponse> =>
  sendAs(deps.messages, requireAuth(request).user.id, pathId(request), request.body, reply);
const history = (deps: MessageRouteDeps, request: FastifyRequest): Promise<HistoryResponse> => historyOf(deps.messages, pathId(request), request.query);
const replies = (deps: MessageRouteDeps, request: FastifyRequest): Promise<RepliesResponse> => repliesOf(deps.messages, pathId(request), request.query);
const edit = (deps: MessageRouteDeps, request: FastifyRequest): Promise<MessageWriteResponse> =>
  editAs(deps.messages, requireAuth(request).user.id, pathId(request), request.body);

async function remove(deps: MessageRouteDeps, request: FastifyRequest): Promise<MessageDeleteResponse> {
  const { message, changeId } = await deps.messages.remove(requireAuth(request).user.id, pathId(request));
  return { message_id: message.id, seq: message.seq, deleted_at: message.deletedAt?.toISOString() ?? '', change_id: changeId };
}

/**
 * 알림 미리보기(TRD §6-2): push payload는 식별자만, SW가 로그인 세션으로 평문만 가져간다.
 * 본문 파생값이므로 캐시 금지(no-store)·로그 금지. 봇 라우트에는 두지 않는다.
 */
async function preview(deps: MessageRouteDeps, request: FastifyRequest, reply: FastifyReply): Promise<MessagePreviewResponse> {
  const text = await deps.messages.preview(pathId(request));
  reply.header('cache-control', 'no-store');
  return { text };
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
  app.get('/api/messages/:id/preview', { config: { access: 'message' }, preHandler: onMessage('read') }, (request, reply) => preview(deps, request, reply));
  app.patch('/api/messages/:id', { config: { access: 'message' }, preHandler: onMessage('write') }, (request) => edit(deps, request));
  app.delete('/api/messages/:id', { config: { access: 'message' }, preHandler: onMessage('write') }, (request) => remove(deps, request));
}
