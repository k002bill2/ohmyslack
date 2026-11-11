import { z } from 'zod';

/** 봇 리스너 HTTP 계약(정본: TRD §5-2 6항). 나머지 봇 라우트는 사람 라우트와 같은 스키마를 쓴다. */
export const BOT_API_PREFIX = '/api/bot/v1';

/**
 * `GET /api/bot/v1/me`: 봇 id, owner(지시 판정 기준) id, 활성 참여 대화 id 목록(호환 유지),
 * 대화 종류(`conversations`)와 봇 표시 이름(멘션 토큰 제거용) — BOT_CHANNEL_SPEC §4-4.
 */
export const botMeSchema = z.object({
  id: z.uuid(),
  owner_user_id: z.uuid(),
  display_name: z.string(),
  conversation_ids: z.array(z.uuid()),
  // name: 채널 이름, DM은 null. 구 서버 응답(name 없음) 호환을 위해 optional.
  conversations: z.array(z.object({ id: z.uuid(), kind: z.enum(['channel', 'dm']), name: z.string().nullable().optional() })),
});

export type BotMe = z.infer<typeof botMeSchema>;
