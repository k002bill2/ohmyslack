import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { markAccountGuard } from '../../http/access.js';
import { HttpError } from '../../http/errors.js';
import {
  inviteAcceptRequestSchema,
  USER_NAMES_MAX_IDS,
  type InviteCreateResponse,
  type MeResponse,
  type MembersResponse,
  type UserNamesResponse,
} from '../../shared.js';
import type { AuthEvents } from '../auth/events.js';
import { accountGuard, adminGuards, requireAuth, SESSION_COOKIE, sessionToken } from '../auth/guards.js';
import { checkPasswordPolicy, hashPassword, normalizeEmail } from '../auth/password.js';
import { COOKIE_OPTIONS, meBody } from '../auth/routes.js';
import { createSerialQueue, hashToken, type AuthService } from '../auth/service.js';
import type { MembersStore } from './store.js';

/** 초대 수명·엔트로피(정본: TRD §5-1 S2). */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const INVITE_TOKEN_BYTES = 32;

export interface MemberRouteDeps {
  readonly auth: AuthService;
  readonly store: MembersStore;
  readonly events: AuthEvents;
  readonly clock: () => number;
}

/** 수락 처리 의존성: 공개 경로의 Argon2 연산은 한 번에 하나만 돈다(작업 풀 고갈 방지, Codex r1 P2). */
interface AcceptDeps extends MemberRouteDeps {
  readonly serial: ReturnType<typeof createSerialQueue>;
}

const idParams = z.object({ id: z.uuid() });
const userParams = z.object({ user_id: z.uuid() });

/**
 * `ids`: 쉼표로 구분한 UUID 1–100개. 형식 오류·빈 값·상한 초과는 400. UUID는 대소문자 무관이라 소문자로 맞춰 중복을 없앤다.
 */
const userNamesQuery = z.object({
  ids: z
    .string()
    .transform((raw) => raw.split(','))
    .pipe(z.array(z.uuid()).min(1).max(USER_NAMES_MAX_IDS))
    .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]),
});

function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'invalid_request');
  return parsed.data;
}

async function createInvite(deps: MemberRouteDeps, request: FastifyRequest, reply: FastifyReply): Promise<InviteCreateResponse> {
  const token = randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
  const id = randomUUID();
  const expiresAt = new Date(deps.clock() + INVITE_TTL_MS);
  await deps.store.insertInvite({ id, tokenHash: hashToken(token), createdBy: requireAuth(request).user.id, expiresAt });
  reply.code(201);
  return { id, token, expires_at: expiresAt.toISOString() };
}

/** 만료·사용·폐기·없는 token과 이미 있는 이메일은 같은 응답이다(S3·NC-20). 정책 위반은 token을 소비하지 않는다. */
async function acceptInvite(deps: AcceptDeps, request: FastifyRequest, reply: FastifyReply): Promise<MeResponse> {
  const body = parseOr400(inviteAcceptRequestSchema, request.body);
  if (!checkPasswordPolicy(body.password).ok) throw new HttpError(400, 'password_policy');
  const tokenHash = hashToken(body.token);
  // 무효 token은 Argon2 전에 같은 오류로 끊는다 — 미인증 요청이 고비용 해시를 반복시키지 못하게(Codex r1 P2).
  if (!(await deps.store.isInviteUsable(tokenHash, new Date(deps.clock())))) throw new HttpError(400, 'invite_invalid');
  const member = {
    id: randomUUID(),
    emailNorm: normalizeEmail(body.email),
    displayName: body.display_name,
    passwordHash: await deps.serial(() => hashPassword(body.password)),
  };
  const result = await deps.store.acceptInvite(tokenHash, new Date(deps.clock()), member);
  if (!result.ok) throw new HttpError(400, 'invite_invalid');
  const user = { ...member, status: 'active' as const, role: 'member' as const };
  const issued = await deps.auth.issueSession(user, sessionToken(request));
  reply.code(201).setCookie(SESSION_COOKIE, issued.token, COOKIE_OPTIONS);
  return meBody(issued);
}

async function deactivate(deps: MemberRouteDeps, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { user_id: targetId } = parseOr400(userParams, request.params);
  const actor = requireAuth(request).user;
  // UUID는 대소문자 무관 — 대문자로 보낸 자기 id도 자기 비활성화로 본다(H-2).
  if (targetId.toLowerCase() === actor.id.toLowerCase()) throw new HttpError(409, 'owner_protected');
  const result = await deps.store.deactivate(actor.id, targetId, new Date(deps.clock()));
  if (!result.ok) {
    if (result.reason === 'last_owner') throw new HttpError(409, 'owner_protected');
    throw result.reason === 'forbidden' ? new HttpError(403, 'forbidden') : new HttpError(404, 'not_found');
  }
  if (result.revokedSessionIds.length > 0) deps.events.sessionRevoked(result.revokedSessionIds);
  return reply.code(204).send();
}

/** 초대·멤버·관리자 라우트(정본: TRD §3, DEV_DESIGN §2-4). */
export function registerMemberRoutes(app: FastifyInstance, deps: MemberRouteDeps): void {
  const account = markAccountGuard(accountGuard(deps.auth));
  const admin = [...adminGuards(deps.auth)];
  const acceptDeps: AcceptDeps = { ...deps, serial: createSerialQueue() };

  app.post('/api/invites', { config: { access: 'admin' }, preHandler: admin }, (request, reply) => createInvite(deps, request, reply));

  app.post('/api/invites/accept', { config: { access: 'public' }, bodyLimit: 4096 }, (request, reply) =>
    acceptInvite(acceptDeps, request, reply),
  );

  app.post('/api/invites/:id/revoke', { config: { access: 'admin' }, preHandler: admin }, async (request, reply) => {
    const { id } = parseOr400(idParams, request.params);
    if (!(await deps.store.revokeInvite(id, new Date(deps.clock())))) throw new HttpError(404, 'not_found');
    return reply.code(204).send();
  });

  app.get('/api/members', { config: { access: 'account' }, preHandler: account }, async (): Promise<MembersResponse> => {
    const members = await deps.store.listActiveMembers();
    return { members: members.map((m) => ({ id: m.id, display_name: m.displayName, role: m.role, kind: m.kind })) };
  });

  // 비활성 멤버가 남긴 메시지 작성자 이름을 채운다(G-50·G-51). 같은 워크스페이스 사용자만, 없는 ID는 빠질 뿐 200.
  app.get('/api/users/names', { config: { access: 'account' }, preHandler: account }, async (request): Promise<UserNamesResponse> => {
    const { ids } = parseOr400(userNamesQuery, request.query);
    const users = await deps.store.findUserNames(requireAuth(request).user.id, ids);
    return { users: users.map((u) => ({ id: u.id, display_name: u.displayName, status: u.status, kind: u.kind })) };
  });

  app.post('/api/admin/members/:user_id/deactivate', { config: { access: 'admin' }, preHandler: admin }, (request, reply) =>
    deactivate(deps, request, reply),
  );
}
