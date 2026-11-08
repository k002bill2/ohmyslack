import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createPgAuthStore } from '../../src/modules/auth/index.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { createPgMembersStore } from '../../src/modules/members/index.js';
import { HOST, login, ORIGIN, sessionCookie, testApp } from '../support/auth-app.js';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import type { TestSchema } from '../support/test-db.js';
import { migratedSchema } from './bootstrap-harness.js';

/** 초대·관리자 int 테스트 공통: 워크스페이스 + owner + member, pg 저장소 앱, 가짜 시계, 발행된 세션 폐기 이벤트. */
export const SECRET = 'correct horse battery staple';

export interface MembersIntContext {
  readonly schema: TestSchema;
  readonly app: FastifyInstance;
  readonly ownerId: string;
  readonly memberId: string;
  readonly revokedEvents: string[][];
  now: number;
}

export interface Session {
  readonly token: string;
  readonly csrf: string;
}

export async function addUser(schema: TestSchema, email: string, role: 'owner' | 'member'): Promise<string> {
  const id = randomUUID();
  await schema.pool.query("INSERT INTO users (id, email_norm, display_name, password_hash, status) VALUES ($1, $2, $3, $4, 'active')", [
    id,
    email,
    email.split('@')[0],
    await hashPassword(SECRET),
  ]);
  await schema.pool.query('INSERT INTO workspace_members (workspace_id, user_id, role) SELECT id, $1, $2 FROM workspaces LIMIT 1', [id, role]);
  return id;
}

export async function setupMembersInt(): Promise<MembersIntContext> {
  const schema = await migratedSchema();
  await schema.pool.query("INSERT INTO workspaces (id, name, created_at) VALUES ($1, 'Home', now())", [randomUUID()]);
  const ownerId = await addUser(schema, 'owner@example.test', 'owner');
  const memberId = await addUser(schema, 'member@example.test', 'member');
  const ctx = { schema, ownerId, memberId, revokedEvents: [] as string[][], now: Date.now(), app: undefined as unknown as FastifyInstance };
  const app = testApp({ authStore: createPgAuthStore(schema.pool), membersStore: createPgMembersStore(schema.pool), clock: () => ctx.now });
  app.authEvents.onSessionRevoked((ids) => ctx.revokedEvents.push([...ids]));
  await app.ready();
  return Object.assign(ctx, { app });
}

export async function teardownMembersInt(ctx: MembersIntContext | undefined): Promise<void> {
  await ctx?.app.close();
  await ctx?.schema.drop();
}

export async function signIn(app: FastifyInstance, email: string, secret = SECRET, origin = ORIGIN): Promise<Session> {
  const res = await login(app, email, secret, undefined, origin);
  if (res.statusCode !== 200) throw new Error(`로그인 실패: ${res.statusCode}`);
  return { token: sessionCookie(res) ?? '', csrf: res.json<{ csrf_token: string }>().csrf_token };
}

export function call(
  app: FastifyInstance,
  method: 'GET' | 'POST',
  url: string,
  session?: Session,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { host: HOST, origin: ORIGIN };
  if (session !== undefined) Object.assign(headers, { cookie: `${SESSION_COOKIE}=${session.token}`, 'x-csrf-token': session.csrf });
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
}

export function acceptBody(token: string, email: string, password = SECRET): Record<string, unknown> {
  return { token, email, display_name: email.split('@')[0] ?? 'x', password };
}

/** 초대·사용자·멤버·세션 테이블 상태(DB 무변경 단언용). */
export async function dbState(schema: TestSchema): Promise<unknown> {
  const [invites, users, members, sessions] = await Promise.all([
    schema.pool.query('SELECT * FROM invites ORDER BY id'),
    schema.pool.query('SELECT * FROM users ORDER BY id'),
    schema.pool.query('SELECT * FROM workspace_members ORDER BY user_id'),
    schema.pool.query('SELECT id, user_id, revoked_at FROM sessions ORDER BY id'),
  ]);
  return { invites: invites.rows, users: users.rows, members: members.rows, sessions: sessions.rows };
}
