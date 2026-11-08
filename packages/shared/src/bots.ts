import { z } from 'zod';

/** 봇 리스너 HTTP 계약(정본: TRD §5-2 6항). 나머지 봇 라우트는 사람 라우트와 같은 스키마를 쓴다. */
export const BOT_API_PREFIX = '/api/bot/v1';

/** `GET /api/bot/v1/me`: 봇 id, owner(지시 판정 기준) id, 활성 참여 대화 id 목록. */
export const botMeSchema = z.object({
  id: z.uuid(),
  owner_user_id: z.uuid(),
  conversation_ids: z.array(z.uuid()),
});

export type BotMe = z.infer<typeof botMeSchema>;
