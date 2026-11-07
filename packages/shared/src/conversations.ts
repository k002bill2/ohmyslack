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

/** `GET /api/conversations` 항목(TRD §3:99). unread 집계는 W-08·W-09에서 채운다(현재 0·빈 배열). */
export const conversationSummarySchema = z.object({
  id: z.uuid(),
  kind: z.enum(['channel', 'dm']),
  name: z.string().nullable(),
  /** DM 상대(채널이면 null). */
  peer_user_id: z.uuid().nullable(),
  last_seq: z.number().int(),
  last_read_seq: z.number().int(),
  unread_count: z.number().int(),
  mention_count: z.number().int(),
  unread_thread_count: z.number().int(),
  unread_threads: z.array(unreadThreadSchema),
});

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationsResponseSchema = z.object({ conversations: z.array(conversationSummarySchema) });

export type ConversationsResponse = z.infer<typeof conversationsResponseSchema>;

export const conversationMembersResponseSchema = z.object({
  members: z.array(z.object({ id: z.uuid(), display_name: z.string() })),
});

export type ConversationMembersResponse = z.infer<typeof conversationMembersResponseSchema>;
