import { z } from 'zod';

/** 초대·멤버·관리자 HTTP 계약(정본: TRD §3 `/api/invites*`·`/api/members`·`/api/admin/members/*`). */
export const inviteAcceptRequestSchema = z
  .object({
    token: z.string().min(1).max(256),
    email: z.string().trim().min(3).max(320).includes('@'),
    display_name: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(1024),
  })
  .strict();

export type InviteAcceptRequest = z.infer<typeof inviteAcceptRequestSchema>;

export const inviteCreateResponseSchema = z.object({
  id: z.uuid(),
  /** 원문 token. 이 응답에서 한 번만 보이고 DB에는 SHA-256만 남는다(S2). */
  token: z.string().min(1),
  expires_at: z.string(),
});

export type InviteCreateResponse = z.infer<typeof inviteCreateResponseSchema>;

export const membersResponseSchema = z.object({
  members: z.array(
    z.object({
      id: z.uuid(),
      display_name: z.string(),
      role: z.enum(['owner', 'member']),
      /** `users.kind`(서버 결정값, W-19b). 봇은 DM 시작 후보·멤버 비활성화 대상이 아니다. */
      kind: z.enum(['human', 'bot']),
    }),
  ),
});

export type MembersResponse = z.infer<typeof membersResponseSchema>;

/** `GET /api/users/names?ids=` 상한(정본: TRD §3). 한 요청에 쉼표로 구분한 UUID 최대 100개. */
export const USER_NAMES_MAX_IDS = 100;

/**
 * `GET /api/users/names` 응답: 같은 워크스페이스 사용자의 표시 이름(비활성 포함). 이메일·역할·세션 정보는 싣지 않는다.
 * 없는 ID·범위 밖 ID는 응답에서 빠질 뿐이다(존재 여부를 응답 코드로 구분하지 않는다).
 */
export const userNamesResponseSchema = z.object({
  users: z.array(
    z
      .object({
        id: z.uuid(),
        display_name: z.string(),
        status: z.enum(['active', 'disabled']),
        kind: z.enum(['human', 'bot']),
      })
      .strict(),
  ),
});

export type UserNamesResponse = z.infer<typeof userNamesResponseSchema>;
