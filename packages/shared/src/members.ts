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
    }),
  ),
});

export type MembersResponse = z.infer<typeof membersResponseSchema>;
