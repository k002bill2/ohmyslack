import { z } from 'zod';

/** 골격 스모크용 최소 계약. 실제 API·WS 스키마는 TRD §3–4를 옮겨 이후 slice에서 추가한다. */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from './auth.js';
export * from './members.js';
