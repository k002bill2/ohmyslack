import { createDecipheriv, createECDH, hkdfSync, randomBytes, randomUUID, type ECDH } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateRequestDetails, generateVAPIDKeys } from 'web-push';
import type pg from 'pg';
import { LOG_CANARIES } from '../../../../tools/log-canaries.js';
import { createPgPushStore, parsePushConfig, type PushConfig, type PushSend } from '../../src/modules/push/index.js';
import { createBotEvents, createBotService } from '../../src/modules/bots/index.js';
import { as, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import type { Session } from '../auth/members-int-harness.js';

/** push 통합 테스트 공통: 가짜 push service(로컬 HTTP), 실제 web-push 암호화·VAPID, 수동 예약, 로그 수집. */
export const ENDPOINT_CANARY = 'OMS-CANARY-PUSHEP-2a9c71';
/** 본문 카나리아(tools/log-canaries.ts). 색인 접근이 `string | undefined`인 tsconfig에서도 string으로 고정한다. */
export const BODY_CANARY: string = LOG_CANARIES.body ?? 'OMS-CANARY-BODY-6f1c2a';

export interface FakeRequest {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface PushIntContext {
  readonly conv: ConvIntContext;
  readonly server: Server;
  readonly received: FakeRequest[];
  readonly logs: string[];
  readonly config: PushConfig;
  readonly tasks: (() => void)[];
  readonly botUserId: string;
  readonly botDm: string;
  now: number;
}

/** 경로에 `status-404`·`status-410`이 있으면 그 상태로, 아니면 201로 응답한다. */
function fakePushService(received: FakeRequest[]): Promise<Server> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = request.url ?? '';
      received.push({ path, headers: request.headers, body: Buffer.concat(chunks) });
      const status = path.includes('status-404') ? 404 : path.includes('status-410') ? 410 : 201;
      response.writeHead(status).end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** 실제 web-push로 요청(암호화 본문·VAPID·TTL·Topic)을 만들고, 전송 대상만 로컬 가짜 서버로 바꾼다. 실제 push service는 호출하지 않는다. */
function localSend(port: () => number): PushSend {
  return (target, payload, options) => {
    const details = generateRequestDetails({ endpoint: target.endpoint, keys: { ...target.keys } }, payload, {
      TTL: options.TTL,
      topic: options.topic,
      vapidDetails: { ...options.vapidDetails },
    });
    const path = new URL(details.endpoint).pathname;
    return new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest({ host: '127.0.0.1', port: port(), path, method: 'POST', headers: details.headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      outgoing.on('error', reject);
      outgoing.end(details.body);
    });
  };
}

export function testVapidConfig(): PushConfig {
  const keys = generateVAPIDKeys();
  const config = parsePushConfig(JSON.stringify({ public_key: keys.publicKey, private_key: keys.privateKey }), 'mailto:ops@example.test');
  if (config === undefined) throw new Error('VAPID 설정 생성 실패');
  return config;
}

export async function setupPushInt(options: { readonly enabled?: boolean } = {}): Promise<PushIntContext> {
  const received: FakeRequest[] = [];
  const logs: string[] = [];
  const tasks: (() => void)[] = [];
  const server = await fakePushService(received);
  const config = testVapidConfig();
  // 저장소는 실행 스키마 풀이 생긴 뒤에 붙는다(질의는 setup 이후 요청에서만 일어난다).
  const lazy: { pool?: pg.Pool } = {};
  const lazyPool = { query: (...args: unknown[]) => (lazy.pool as unknown as { query: (...a: unknown[]) => unknown }).query(...args) } as unknown as pg.Pool;
  const ctx = { now: Date.parse('2026-11-09T00:00:00Z') } as PushIntContext;
  const conv = await setupConvInt({
    clock: () => ctx.now,
    logger: { log: (fields) => logs.push(JSON.stringify(fields)) },
    pushStore: createPgPushStore(lazyPool),
    push: {
      ...(options.enabled === false ? {} : { config }),
      send: localSend(() => (server.address() as AddressInfo).port),
      schedule: (task) => tasks.push(task),
    },
  });
  lazy.pool = conv.schema.pool;
  const bot = await createBotService({ pool: conv.schema.pool, events: createBotEvents() }).createBot({ displayName: 'Jarvis', slug: 'jarvis' });
  return Object.assign(ctx, { conv, server, received, logs, config, tasks, botUserId: bot.botUserId, botDm: bot.dmConversationId });
}

export async function teardownPushInt(ctx: PushIntContext | undefined): Promise<void> {
  if (ctx === undefined) return;
  await flush(ctx);
  await teardownConvInt(ctx.conv);
  await new Promise((resolve) => ctx.server.close(resolve));
}

/** 예약된 전송 작업을 모두 실행하고 끝날 때까지 기다린다. */
export async function flush(ctx: PushIntContext): Promise<void> {
  for (let i = 0; i < 100 && ctx.tasks.length > 0; i += 1) {
    const batch = ctx.tasks.splice(0);
    for (const task of batch) task();
    await ctx.conv.app.pushService?.idle();
  }
}

/** 구독 기기: 브라우저처럼 P-256 ECDH 키쌍 + 16바이트 auth를 만든다(키는 테스트 메모리에만). */
export interface Device {
  readonly ecdh: ECDH;
  readonly auth: Buffer;
  readonly endpoint: string;
}

export function device(path = 'ok'): Device {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, auth: randomBytes(16), endpoint: `https://web.push.apple.com/${ENDPOINT_CANARY}-${path}-${randomUUID()}` };
}

export function subscriptionBody(d: Device, endpoint = d.endpoint): Record<string, unknown> {
  return { endpoint, expirationTime: null, keys: { p256dh: d.ecdh.getPublicKey().toString('base64url'), auth: d.auth.toString('base64url') } };
}

export async function subscribe(ctx: PushIntContext, session: Session, d: Device): Promise<string> {
  const res = await req(ctx.conv.app, 'POST', '/api/push/subscriptions', session, subscriptionBody(d));
  if (res.statusCode !== 201) throw new Error(`구독 실패: ${res.statusCode} ${res.body}`);
  return res.json<{ subscription: { id: string } }>().subscription.id;
}

export async function subscriptionCount(ctx: PushIntContext): Promise<number> {
  const res = await ctx.conv.schema.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM push_subscriptions');
  return res.rows[0]?.n ?? -1;
}

export async function sendAs(ctx: PushIntContext, authorId: string, conversationId: string, extra: { threadRootId?: string; mentionUserIds?: string[]; body?: string } = {}): Promise<string> {
  const services = ctx.conv.app.domainServices;
  if (services === undefined) throw new Error('도메인 서비스 없음');
  const out = await services.messages.send(authorId, conversationId, {
    clientMessageId: randomUUID(),
    body: extra.body ?? BODY_CANARY,
    threadRootId: extra.threadRootId ?? null,
    mentionUserIds: extra.mentionUserIds ?? [],
  });
  return out.message.id;
}

/** RFC 8291 + RFC 8188(aes128gcm) 복호화: 구독 개인키·auth로 payload 평문을 얻는다. */
export function decrypt(d: Device, body: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20] ?? 0;
  const serverKey = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const shared = d.ecdh.computeSecret(serverKey);
  const info = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), d.ecdh.getPublicKey(), serverKey]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, d.auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end -= 1;
  if (plain[end - 1] !== 2) throw new Error('마지막 레코드 구분자 없음');
  return plain.subarray(0, end - 1).toString('utf8');
}

export { as, req };
export type { Session };
