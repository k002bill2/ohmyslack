import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { AppOptions } from '../../src/app.js';
import { createPgAttachmentsStore } from '../../src/modules/attachments/index.js';
import { createPgAuthStore } from '../../src/modules/auth/index.js';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { createPgConversationsStore } from '../../src/modules/conversations/index.js';
import { createPgMembersStore } from '../../src/modules/members/index.js';
import { createPgMessagesStore } from '../../src/modules/messages/index.js';
import { createPgSyncStore } from '../../src/modules/sync/index.js';
import { addUser, signIn, type Session } from '../auth/members-int-harness.js';
import { migratedSchema } from '../auth/bootstrap-harness.js';
import { HOST, ORIGIN, testApp } from '../support/auth-app.js';
import type { TestSchema, TestSchemaOptions } from '../support/test-db.js';

/** 대화 int 테스트 공통: 워크스페이스 + owner A + 멤버 B·C·L·D, 세 저장소를 모두 연결한 앱. */
export interface ConvIntContext {
  readonly schema: TestSchema;
  readonly app: FastifyInstance;
  readonly ids: Readonly<Record<'a' | 'b' | 'c' | 'l' | 'd', string>>;
  readonly ended: [string, string][];
}

export type Method = 'GET' | 'POST' | 'DELETE' | 'HEAD' | 'PUT' | 'PATCH';

/** extra: WS 테스트가 실제 포트 Host·heartbeat를 주입할 때만 쓴다. */
export async function setupConvInt(
  extra: Pick<AppOptions, 'extraHosts' | 'realtime' | 'clock' | 'pushStore' | 'push' | 'logger'> = {},
  schemaOptions: TestSchemaOptions = {},
): Promise<ConvIntContext> {
  const schema = await migratedSchema(schemaOptions);
  await schema.pool.query("INSERT INTO workspaces (id, name, created_at) VALUES ($1, 'Home', now())", [randomUUID()]);
  const ids = {
    a: await addUser(schema, 'a@example.test', 'owner'),
    b: await addUser(schema, 'b@example.test', 'member'),
    c: await addUser(schema, 'c@example.test', 'member'),
    l: await addUser(schema, 'l@example.test', 'member'),
    d: await addUser(schema, 'd@example.test', 'member'),
  };
  const app = testApp({
    authStore: createPgAuthStore(schema.pool),
    membersStore: createPgMembersStore(schema.pool),
    conversationsStore: createPgConversationsStore(schema.pool),
    messagesStore: createPgMessagesStore(schema.pool),
    syncStore: createPgSyncStore(schema.pool),
    attachmentsStore: createPgAttachmentsStore(schema.pool),
    ...extra,
  });
  const ended: [string, string][] = [];
  app.conversationEvents.onMembershipEnded((cid, uid) => ended.push([cid, uid]));
  await app.ready();
  return { schema, app, ids, ended };
}

export async function teardownConvInt(ctx: ConvIntContext | undefined): Promise<void> {
  await ctx?.app.close();
  await ctx?.schema.drop();
}

export function as(app: FastifyInstance, email: string): Promise<Session> {
  return signIn(app, `${email}@example.test`);
}

export function req(
  app: FastifyInstance,
  method: Method,
  url: string,
  session?: Session,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { host: HOST, origin: ORIGIN };
  if (session !== undefined) Object.assign(headers, { cookie: `${SESSION_COOKIE}=${session.token}`, 'x-csrf-token': session.csrf });
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
}

export async function createChannel(app: FastifyInstance, owner: Session, name: string): Promise<string> {
  const res = await req(app, 'POST', '/api/conversations', owner, { kind: 'channel', name });
  if (res.statusCode !== 201) throw new Error(`채널 생성 실패: ${res.statusCode}`);
  return res.json<{ id: string }>().id;
}

export async function openDm(app: FastifyInstance, session: Session, userId: string): Promise<LightMyRequestResponse> {
  return req(app, 'POST', '/api/dms', session, { user_id: userId });
}

/** 대화 3테이블 상태(데이터 변화 0 단언용). */
export async function convState(schema: TestSchema): Promise<unknown> {
  const [convs, members, reads] = await Promise.all([
    schema.pool.query('SELECT * FROM conversations ORDER BY id'),
    schema.pool.query('SELECT * FROM conversation_members ORDER BY conversation_id, user_id'),
    schema.pool.query('SELECT * FROM conversation_read_state ORDER BY conversation_id, user_id'),
  ]);
  return { convs: convs.rows, members: members.rows, reads: reads.rows };
}
