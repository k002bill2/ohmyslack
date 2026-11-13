import { z } from 'zod';

/** 인증 HTTP 계약(정본: TRD §3 `/api/auth/*`·`/api/me`·`/api/sessions`). JSON 필드는 snake_case. */
export const loginRequestSchema = z
  .object({
    email: z.string().min(1).max(320),
    password: z.string().min(1).max(1024),
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const meResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.string(),
    display_name: z.string(),
    role: z.enum(['owner', 'member']),
  }),
  csrf_token: z.string().min(1),
});

export type MeResponse = z.infer<typeof meResponseSchema>;

/** 기기 세션 거친 라벨 길이 상한(code point, TRD §5-3 1항·DB CHECK `0006`). */
export const SESSION_DEVICE_LABEL_MAX = 64;

/** `GET /api/sessions`(TRD §3·§5-3 3항): 본인의 살아 있는 세션만. `device_label`은 모르면 null. */
export const sessionsResponseSchema = z.object({
  sessions: z.array(
    z.object({
      id: z.uuid(),
      device_label: z.string().min(1).max(SESSION_DEVICE_LABEL_MAX).nullable(),
      created_at: z.string(),
      last_seen_at: z.string(),
      current: z.boolean(),
    }),
  ),
});

export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;

/** 오류 형식 `{error:{code,request_id}}` — 본문·token·SQL·stack 없음(TRD §3). */
export const errorResponseSchema = z
  .object({
    error: z.object({ code: z.string().min(1), request_id: z.string().min(1) }).strict(),
  })
  .strict();

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
