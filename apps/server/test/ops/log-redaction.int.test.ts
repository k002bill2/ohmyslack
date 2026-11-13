import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOG_CANARIES } from '../../../../tools/log-canaries.js';
import { createPgAttachmentsStore } from '../../src/modules/attachments/repo.js';
import { createPgAuthStore } from '../../src/modules/auth/index.js';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { createPgConversationsStore } from '../../src/modules/conversations/index.js';
import { createPgMembersStore } from '../../src/modules/members/index.js';
import { createPgMessagesStore } from '../../src/modules/messages/index.js';
import { LOG_ALLOWED_FIELDS, createOpsLogger, type OpsLogger } from '../../src/modules/ops/logger.js';
import { createPgSyncStore } from '../../src/modules/sync/index.js';
import { METRIC_ALLOWLIST } from '../../src/shared.js';
import { addUser, signIn } from '../auth/members-int-harness.js';
import { migratedSchema } from '../auth/bootstrap-harness.js';
import { createChannel, req } from '../conversations/conv-int-harness.js';
import { closeAll, connect, connected, freePort, listen, subscribe, type WsClient } from '../realtime/ws-int-harness.js';
import { HOST, ORIGIN, login, testApp } from '../support/auth-app.js';
import type { TestSchema } from '../support/test-db.js';
import { buildZip, docxEntries } from '../attachments/fixtures/zip-builder.js';

/**
 * FR-OPS-03 앱 로그 카나리아 0건(DEV_DESIGN §2-2 B6, PRD §10).
 * 카나리아를 HTTP·WS 경로로 흘리고 ops 로거 직렬화 출력과 프로세스 stdout·stderr를 캡처해 검사한다.
 * reports/int/*.log 사후 grep(check:log-leak)과 달리, 이 테스트는 직렬화 지점 자체를 판정한다.
 */
let schema: TestSchema | undefined;
let app: FastifyInstance | undefined;
const clients: WsClient[] = [];

afterEach(async () => {
  closeAll(clients.splice(0));
  vi.restoreAllMocks();
  await app?.close();
  await schema?.drop();
  app = undefined;
  schema = undefined;
});

const CANARY = LOG_CANARIES as Readonly<Record<'body' | 'credential' | 'token' | 'cookie' | 'invite' | 'email' | 'filename', string>>;
const ALLOWED_KEYS: ReadonlySet<string> = new Set<string>([
  ...LOG_ALLOWED_FIELDS,
  ...Object.values(METRIC_ALLOWLIST).flat(),
]);

/** 프로세스 stdout·stderr 쓰기를 가로채 원래 출력도 유지한다. */
function captureProcessOutput(): string[] {
  const written: string[] = [];
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return original(chunk, ...rest);
    }) as typeof stream.write);
  }
  return written;
}

/**
 * 부주의한 로그 호출자 흉내: 원시 요청 문맥(URL·쿼리·헤더·본문)을 그대로 로거에 넘긴다.
 * 직렬화 단계 redaction(B6)이 유일한 관문임을 판정하기 위한 것으로, 운영 코드에는 없다.
 */
function registerCarelessProbe(target: FastifyInstance, logger: OpsLogger): void {
  target.addHook('onResponse', async (request, reply) => {
    logger.log({ event: 'probe', status_code: reply.statusCode, url: request.url, query: request.query, headers: request.headers, body: request.body });
  });
}

async function setup(lines: string[]): Promise<{ base: string }> {
  schema = await migratedSchema();
  await schema.pool.query("INSERT INTO workspaces (id, name, created_at) VALUES ($1, 'Home', now())", [randomUUID()]);
  await addUser(schema, 'a@example.test', 'owner');
  await addUser(schema, 'b@example.test', 'member');
  const port = await freePort();
  const logger = createOpsLogger((line) => lines.push(line));
  app = testApp({
    extraHosts: [`127.0.0.1:${port}`],
    logger,
    authStore: createPgAuthStore(schema.pool),
    membersStore: createPgMembersStore(schema.pool),
    conversationsStore: createPgConversationsStore(schema.pool),
    messagesStore: createPgMessagesStore(schema.pool),
    syncStore: createPgSyncStore(schema.pool),
    attachmentsStore: createPgAttachmentsStore(schema.pool),
  });
  registerCarelessProbe(app, logger);
  return { base: await listen(app, port) };
}

describe('FR-OPS-03 로그 redaction', () => {
  it('FR-OPS-03 합성 본문·자격 증명·토큰 카나리아가 앱·HTTP·WS 로그에 0건이고 허용 계측 필드만 기록된다', async () => {
    const processOutput = captureProcessOutput();
    const lines: string[] = [];
    const { base } = await setup(lines);
    const target = app as FastifyInstance;

    // HTTP: 비밀번호·이메일 카나리아로 로그인 실패, 위조 세션 쿠키, 쿼리 토큰, 초대 토큰, 깨진 JSON.
    expect((await login(target, CANARY.email, CANARY.credential)).statusCode).toBe(401);
    expect((await login(target, 'a@example.test', CANARY.credential)).statusCode).toBe(401);
    const a = await signIn(target, 'a@example.test');
    const b = await signIn(target, 'b@example.test');
    const forged = await target.inject({ method: 'GET', url: '/api/me', headers: { host: HOST, cookie: `${SESSION_COOKIE}=${CANARY.cookie}` } });
    expect(forged.statusCode).toBe(401);
    const withQuery = await target.inject({
      method: 'GET',
      url: `/api/me?token=${CANARY.token}`,
      headers: { host: HOST, cookie: `${SESSION_COOKIE}=${a.token}; tracking=${CANARY.cookie}`, authorization: `Bearer ${CANARY.token}` },
    });
    expect(withQuery.statusCode).toBe(200);
    const invite = await target.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { host: HOST, origin: ORIGIN },
      payload: { token: CANARY.invite, email: CANARY.email, display_name: 'Canary', password: CANARY.credential },
    });
    expect(invite.statusCode).toBe(400);
    const brokenJson = await target.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: `{"email":"${CANARY.email}","password":"${CANARY.credential}"`,
    });
    expect(brokenJson.statusCode).toBe(400);
    expect((await target.inject({ method: 'GET', url: `/api/nope/${CANARY.token}`, headers: { host: HOST } })).statusCode).toBe(404);

    // HTTP + WS: 본문 카나리아 메시지·답글·수정이 B의 WS로 실제 전달된다(카나리아가 WS 경로를 지났음을 확인).
    const cid = await createChannel(target, a, 'general');
    expect((await req(target, 'POST', `/api/conversations/${cid}/join`, b)).statusCode).toBe(200);
    const wsB = await connected(base, { token: b.token });
    clients.push(wsB);
    expect((await subscribe(wsB, cid)).type).toBe('conversation.subscribed');
    const sent = await req(target, 'POST', `/api/conversations/${cid}/messages`, a, { client_message_id: randomUUID(), body: `hello ${CANARY.body}` });
    expect(sent.statusCode).toBe(201);
    const rootId = sent.json<{ message: { id: string } }>().message.id;
    const created = await wsB.waitFor((f) => f.type === 'message.created');
    expect(JSON.stringify(created)).toContain(CANARY.body);
    const reply = await req(target, 'POST', `/api/conversations/${cid}/messages`, a, {
      client_message_id: randomUUID(),
      body: `reply ${CANARY.body}`,
      thread_root_id: rootId,
    });
    expect(reply.statusCode).toBe(201);
    expect((await req(target, 'PATCH', `/api/messages/${rootId}`, a, { body: `edited ${CANARY.body}` })).statusCode).toBe(200);
    await wsB.waitFor((f) => f.type === 'message.updated' && JSON.stringify(f).includes(`edited ${CANARY.body}`));
    // WS: 카나리아를 담은 잘못된 프레임, 위조 쿠키·토큰 쿼리 handshake.
    wsB.sendRaw(JSON.stringify({ type: 'nope', body: CANARY.body, token: CANARY.token }));
    await wsB.waitFor((f) => f.type === 'error');
    expect(await connect(base, { token: CANARY.cookie })).toBe('rejected');

    // 첨부: 파일명 카나리아 문서 업로드(저장·확장자 불일치 415)·다운로드 — 파일명은 응답에만 있고 로그에는 0건(W-26).
    const docHeaders = (name: string) => ({
      host: HOST,
      origin: ORIGIN,
      cookie: `${SESSION_COOKIE}=${a.token}`,
      'x-csrf-token': a.csrf,
      'content-type': 'application/octet-stream',
      'x-attachment-filename': encodeURIComponent(name),
    });
    const doc = await target.inject({
      method: 'POST',
      url: `/api/attachments?conversation_id=${cid}`,
      headers: docHeaders(`${CANARY.filename}.docx`),
      payload: buildZip(docxEntries()),
    });
    expect(doc.statusCode).toBe(201);
    const docId = doc.json<{ attachment_id: string }>().attachment_id;
    const docGet = await target.inject({ method: 'GET', url: `/api/attachments/${docId}`, headers: { host: HOST, cookie: `${SESSION_COOKIE}=${a.token}` } });
    expect(docGet.statusCode).toBe(200);
    expect(docGet.headers['content-disposition']).toContain(CANARY.filename);
    const mismatch = await target.inject({
      method: 'POST',
      url: `/api/attachments?conversation_id=${cid}`,
      headers: docHeaders(`${CANARY.filename}.xlsx`),
      payload: buildZip(docxEntries()),
    });
    expect(mismatch.statusCode).toBe(415);

    // 판정: 로그가 실제로 기록됐고, 카나리아 0건, 허용 키만.
    expect(lines.length).toBeGreaterThan(10);
    const leaks = [...lines, ...processOutput].flatMap((line) =>
      Object.entries(CANARY).filter(([, value]) => line.includes(value)).map(([kind]) => `${kind}: ${line.slice(0, 120)}`),
    );
    expect(leaks).toEqual([]);
    for (const line of lines) {
      const keys = Object.keys(JSON.parse(line) as Record<string, unknown>);
      expect(keys.filter((key) => !ALLOWED_KEYS.has(key)), line).toEqual([]);
    }
  });
});
