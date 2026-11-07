import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../http/errors.js';
import { inviteAcceptRequestSchema, type InviteCreateResponse, type MeResponse, type MembersResponse } from '../../shared.js';
import type { AuthEvents } from '../auth/events.js';
import { accountGuard, adminGuards, requireAuth, SESSION_COOKIE, sessionToken } from '../auth/guards.js';
import { checkPasswordPolicy, hashPassword, normalizeEmail } from '../auth/password.js';
import { COOKIE_OPTIONS, meBody } from '../auth/routes.js';
import { hashToken, type AuthService } from '../auth/service.js';
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

const idParams = z.object({ id: z.uuid() });
const userParams = z.object({ user_id: z.uuid() });

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
async function acceptInvite(deps: MemberRouteDeps, request: FastifyRequest, reply: FastifyReply): Promise<MeResponse> {
  const body = parseOr400(inviteAcceptRequestSchema, request.body);
  if (!checkPasswordPolicy(body.password).ok) throw new HttpError(400, 'password_policy');
  const member = {
    id: randomUUID(),
    emailNorm: normalizeEmail(body.email),
    displayName: body.display_name,
    passwordHash: await hashPassword(body.password),
  };
  const result = await deps.store.acceptInvite(hashToken(body.token), new Date(deps.clock()), member);
  if (!result.ok) throw new HttpError(400, 'invite_invalid');
  const user = { ...member, status: 'active' as const, role: 'member' as const };
  const issued = await deps.auth.issueSession(user, sessionToken(request));
  reply.code(201).setCookie(SESSION_COOKIE, issued.token, COOKIE_OPTIONS);
  return meBody(issued);
}

async function deactivate(deps: MemberRouteDeps, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { user_id: targetId } = parseOr400(userParams, request.params);
  const actor = requireAuth(request).user;
  if (targetId === actor.id) throw new HttpError(409, 'owner_protected');
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
  const account = accountGuard(deps.auth);
  const admin = [...adminGuards(deps.auth)];

  app.post('/api/invites', { config: { access: 'admin' }, preHandler: admin }, (request, reply) => createInvite(deps, request, reply));

  app.post('/api/invites/accept', { config: { access: 'public' }, bodyLimit: 4096 }, (request, reply) =>
    acceptInvite(deps, request, reply),
  );

  app.post('/api/invites/:id/revoke', { config: { access: 'admin' }, preHandler: admin }, async (request, reply) => {
    const { id } = parseOr400(idParams, request.params);
    if (!(await deps.store.revokeInvite(id, new Date(deps.clock())))) throw new HttpError(404, 'not_found');
    return reply.code(204).send();
  });

  app.get('/api/members', { config: { access: 'account' }, preHandler: account }, async (): Promise<MembersResponse> => {
    const members = await deps.store.listActiveMembers();
    return { members: members.map((m) => ({ id: m.id, display_name: m.displayName, role: m.role })) };
  });

  app.post('/api/admin/members/:user_id/deactivate', { config: { access: 'admin' }, preHandler: admin }, (request, reply) =>
    deactivate(deps, request, reply),
  );
}
