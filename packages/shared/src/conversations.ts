import { z } from 'zod';

/** 대화 공간 HTTP 계약(정본: TRD §3 `/api/conversations*`·`/api/dms`). */
export const CHANNEL_NAME_MAX = 80;
export const DISCOVER_LIMIT_MAX = 100;

export const channelCreateRequestSchema = z
  .object({
    kind: z.literal('channel'),
    name: z.string().max(CHANNEL_NAME_MAX * 4),
  })
  .strict();

export type ChannelCreateRequest = z.infer<typeof channelCreateRequestSchema>;

export const dmCreateRequestSchema = z.object({ user_id: z.uuid() }).strict();

export type DmCreateRequest = z.infer<typeof dmCreateRequestSchema>;

export const discoverQuerySchema = z
  .object({
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(DISCOVER_LIMIT_MAX).optional(),
  })
  .strict();

export type DiscoverQuery = z.infer<typeof discoverQuerySchema>;

export const conversationRefSchema = z.object({ id: z.uuid() });

export type ConversationRef = z.infer<typeof conversationRefSchema>;

/** 미참여 공개 채널. 메시지·멤버 정보는 싣지 않는다(DEV_DESIGN §2-4 discover 예외). */
export const discoverResponseSchema = z.object({
  channels: z.array(z.object({ id: z.uuid(), name: z.string() })),
  next_cursor: z.uuid().nullable(),
});

export type DiscoverResponse = z.infer<typeof discoverResponseSchema>;

export const unreadThreadSchema = z.object({
  root_message_id: z.uuid(),
  last_read_seq: z.number().int(),
  last_reply_seq: z.number().int(),
  unread_reply_count: z.number().int(),
  mention_count: z.number().int(),
});

/** `GET /api/conversations` 항목(TRD §3:99). unread·mention·스레드 집계는 목록 쿼리 하나로 채운다(W-09a). */
export const conversationSummarySchema = z.object({
  id: z.uuid(),
  kind: z.enum(['channel', 'dm']),
  name: z.string().nullable(),
  /** DM 상대(채널이면 null). */
  peer_user_id: z.uuid().nullable(),
  /** DM 상대의 `users.kind`(채널이면 null). 상대가 비활성이어도 채운다 — 봇 DM 배지·고정이 `GET /api/members`(활성만)에 묶이지 않게(W-22b). 하위 호환 추가 필드. */
  peer_kind: z.enum(['human', 'bot']).nullable().optional(),
  last_seq: z.number().int(),
  last_read_seq: z.number().int(),
  unread_count: z.number().int(),
  mention_count: z.number().int(),
  unread_thread_count: z.number().int(),
  unread_threads: z.array(unreadThreadSchema),
});

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

/** 목록 cursor paging(TRD §3: 최대 100, offset 금지). 쿼리 계약은 discover와 같다. */
export const conversationsQuerySchema = discoverQuerySchema;

export const conversationsResponseSchema = z.object({
  conversations: z.array(conversationSummarySchema),
  next_cursor: z.uuid().nullable(),
});

export type ConversationsResponse = z.infer<typeof conversationsResponseSchema>;

export const conversationMembersResponseSchema = z.object({
  members: z.array(z.object({ id: z.uuid(), display_name: z.string() })),
});

export type ConversationMembersResponse = z.infer<typeof conversationMembersResponseSchema>;
