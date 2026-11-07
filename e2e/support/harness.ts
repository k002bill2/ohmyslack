import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createPgAuthStore } from '../../apps/server/src/modules/auth/index.js';
import { SESSION_COOKIE } from '../../apps/server/src/modules/auth/routes.js';
import { createPgConversationsStore } from '../../apps/server/src/modules/conversations/index.js';
import { createPgMembersStore } from '../../apps/server/src/modules/members/index.js';
import { createPgMessagesStore } from '../../apps/server/src/modules/messages/index.js';
import { createPgSyncStore } from '../../apps/server/src/modules/sync/index.js';
import type { MessageView, SyncResponse } from '../../apps/server/src/shared.js';
import { addUser, type Session } from '../../apps/server/test/auth/members-int-harness.js';
import { migratedSchema } from '../../apps/server/test/auth/bootstrap-harness.js';
import { ORIGIN, testApp } from '../../apps/server/test/support/auth-app.js';
import type { TestSchema } from '../../apps/server/test/support/test-db.js';

/** 프로토콜 E2E: 격리 스키마 + 실제 TCP 리스너(WS는 진짜 소켓). REST 준비 호출은 app.inject를 쓴다. */
export interface E2eContext {
  readonly schema: TestSchema;
  readonly app: ReturnType<typeof testApp>;
  readonly ids: Readonly<Record<'a' | 'b' | 'c', string>>;
  readonly baseUrl: string;
  readonly wsUrl: string;
}

/** Node 내장 WebSocket은 Host를 덮어쓰므로 포트를 먼저 잡아 extraHosts에 넣고 같은 포트로 listen한다. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export async function setupE2e(): Promise<E2eContext> {
  const schema = await migratedSchema();
  await schema.pool.query("INSERT INTO workspaces (id, name, created_at) VALUES ($1, 'Home', now())", [randomUUID()]);
  const ids = {
    a: await addUser(schema, 'a@example.test', 'owner'),
    b: await addUser(schema, 'b@example.test', 'member'),
    c: await addUser(schema, 'c@example.test', 'member'),
  };
  const port = await freePort();
  const host = `127.0.0.1:${port}`;
  const app = testApp({
    extraHosts: [host],
    authStore: createPgAuthStore(schema.pool),
    membersStore: createPgMembersStore(schema.pool),
    conversationsStore: createPgConversationsStore(schema.pool),
    messagesStore: createPgMessagesStore(schema.pool),
    syncStore: createPgSyncStore(schema.pool),
  });
  await app.listen({ host: '127.0.0.1', port });
  return { schema, app, ids, baseUrl: `http://${host}`, wsUrl: `ws://${host}/api/ws` };
}

export async function teardownE2e(ctx: E2eContext | undefined): Promise<void> {
  await ctx?.app.close();
  await ctx?.schema.drop();
}

/** 실제 HTTP(fetch)로 호출한다. 서버가 닫혀 있으면 reject된다. */
export async function http<T>(ctx: E2eContext, method: string, path: string, session: Session, payload?: unknown): Promise<T> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      cookie: `${SESSION_COOKIE}=${session.token}`,
      'x-csrf-token': session.csrf,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} 실패: ${res.status}`);
  return (await res.json()) as T;
}

/** after부터 끝까지 sync 페이지를 따라가 변경을 모은다(실제 HTTP). */
export async function syncFrom(ctx: E2eContext, session: Session, after: number): Promise<{ changes: SyncResponse['changes']; through: number }> {
  const changes: SyncResponse['changes'] = [];
  let query = `after=${after}&limit=100`;
  for (let i = 0; i < 1000; i += 1) {
    const page = await http<SyncResponse>(ctx, 'GET', `/api/sync?${query}`, session);
    changes.push(...page.changes);
    if (!page.has_more) return { changes, through: page.through_cursor };
    query = `after=${page.next_cursor}&through=${page.through_cursor}&limit=100`;
  }
  throw new Error('sync 페이지 상한 초과');
}

/** 메시지 id 기준 접기 상태: change_id가 큰 쪽만 남긴다(중복·역순 수신에 멱등). */
export interface Folded {
  readonly changeId: number;
  readonly conversationId: string;
  readonly seq: number;
  readonly body: string | null;
  readonly deleted: boolean;
}

export type FoldState = ReadonlyMap<string, Folded>;

export function foldChange(state: FoldState, id: string, next: Folded): FoldState {
  const cur = state.get(id);
  if (cur !== undefined && cur.changeId >= next.changeId) return state;
  return new Map(state).set(id, next);
}

export function foldMessage(state: FoldState, changeId: number, m: MessageView): FoldState {
  return foldChange(state, m.id, {
    changeId,
    conversationId: m.conversation_id,
    seq: m.seq,
    body: m.deleted_at === null ? m.body : null,
    deleted: m.deleted_at !== null,
  });
}

/** 서버 진실(DB 원장): 대화별 seq 순 (id, body, deleted). */
export async function truth(ctx: E2eContext, conversationIds: readonly string[]): Promise<{ id: string; conversationId: string; seq: number; body: string | null; deleted: boolean }[]> {
  const res = await ctx.schema.pool.query<{ id: string; conversation_id: string; seq: string; body: string | null; deleted_at: Date | null }>(
    'SELECT id, conversation_id, seq, body, deleted_at FROM messages WHERE conversation_id = ANY($1::uuid[]) ORDER BY conversation_id, seq',
    [conversationIds],
  );
  return res.rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    seq: Number(r.seq),
    body: r.deleted_at === null ? r.body : null,
    deleted: r.deleted_at !== null,
  }));
}

/** 접힌 상태를 진실과 같은 모양(대화·seq 순)으로 정렬한다. */
export function foldedRows(state: FoldState, conversationIds: readonly string[]): { id: string; conversationId: string; seq: number; body: string | null; deleted: boolean }[] {
  return [...state.entries()]
    .filter(([, v]) => conversationIds.includes(v.conversationId))
    .map(([id, v]) => ({ id, conversationId: v.conversationId, seq: v.seq, body: v.body, deleted: v.deleted }))
    .sort((x, y) => (x.conversationId === y.conversationId ? x.seq - y.seq : x.conversationId < y.conversationId ? -1 : 1));
}
