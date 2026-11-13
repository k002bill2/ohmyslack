import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpsLogger } from '../../src/modules/ops/logger.js';
import { sessionsResponseSchema, WS_CLOSE_POLICY } from '../../src/shared.js';
import { createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { closeAll, closeLatency, connected, freePort, listen, subscribe, type WsClient } from '../realtime/ws-int-harness.js';
import { HOST, ORIGIN, sessionCookie } from '../support/auth-app.js';
import { SECRET, type Session } from './members-int-harness.js';

/**
 * FR-AUTH-04 기기 세션 목록·원격 로그아웃(TRD §3·§5-3, TM-HTTP-21–23, DEV_DESIGN 6-6).
 * 실제 포트(WS) + pg 저장소. 로그는 ops 로거 출력 줄을 배열로 모은다(원문 UA·세션 ID·라벨 0 단언).
 */
const UA_CANARY = 'OMS-CANARY-UA-7d41c9';
const IPHONE_UA = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1 ${UA_CANARY}`;
const MAC_CHROME_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 ${UA_CANARY}`;

interface Ctx {
  readonly conv: ConvIntContext;
  readonly base: string;
  readonly logs: string[];
  readonly clients: WsClient[];
}

let ctx: Ctx;

beforeEach(async () => {
  const logs: string[] = [];
  const port = await freePort();
  const conv = await setupConvInt({ extraHosts: [`127.0.0.1:${port}`], logger: createOpsLogger((line) => logs.push(line)) });
  const base = await listen(conv.app, port);
  ctx = { conv, base, logs, clients: [] };
});

afterEach(async () => {
  closeAll(ctx.clients);
  await teardownConvInt(ctx.conv);
});

async function loginAs(app: FastifyInstance, email: string, userAgent?: string): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: HOST, origin: ORIGIN, ...(userAgent === undefined ? {} : { 'user-agent': userAgent }) },
    payload: { email, password: SECRET },
  });
  if (res.statusCode !== 200) throw new Error(`로그인 실패: ${res.statusCode}`);
  return { token: sessionCookie(res) ?? '', csrf: res.json<{ csrf_token: string }>().csrf_token };
}

async function sessionIdOf(token: string): Promise<string> {
  const hash = createHash('sha256').update(token, 'utf8').digest('hex');
  const res = await ctx.conv.schema.pool.query<{ id: string }>('SELECT id FROM sessions WHERE token_hash = $1', [hash]);
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error('세션 행 없음');
  return id;
}

async function addPushSubscription(userId: string, sessionId: string): Promise<void> {
  await ctx.conv.schema.pool.query(
    `INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, vapid_key_id, created_at)
     VALUES ($1, $2, $3, $4, 'p', 'a', 'k', now())`,
    [randomUUID(), userId, sessionId, `https://push.example.test/${randomUUID()}`],
  );
}

async function subscriptionCount(sessionId: string): Promise<number> {
  const res = await ctx.conv.schema.pool.query('SELECT 1 FROM push_subscriptions WHERE session_id = $1', [sessionId]);
  return res.rowCount ?? 0;
}

async function sessionRow(id: string): Promise<unknown> {
  return (await ctx.conv.schema.pool.query('SELECT * FROM sessions WHERE id = $1', [id])).rows[0];
}

/** 404 응답 비교용: request_id·date처럼 요청마다 다른 값만 지운다. */
function shape(res: LightMyRequestResponse): unknown {
  const body = res.json<{ error: { code: string; request_id: string } }>();
  const headers = Object.fromEntries(Object.entries(res.headers).filter(([key]) => key !== 'date'));
  const requestId = body.error.request_id;
  const scrub = (value: unknown): unknown => (typeof value === 'string' ? value.split(requestId).join('<rid>') : value);
  return {
    status: res.statusCode,
    body: { error: { ...body.error, request_id: '<rid>' } },
    headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, scrub(value)])),
  };
}

describe('기기 세션 원격 로그아웃', () => {
  it('FR-AUTH-04 본인 세션 목록은 거친 기기 라벨만 싣고 원격 로그아웃은 본인 세션만 폐기해 5초 안에 그 세션의 WS를 닫고 push 구독을 지우며 남의 세션과 없는 세션은 같은 404다', async () => {
    const { app, ids } = ctx.conv;
    const phone = await loginAs(app, 'a@example.test', IPHONE_UA);
    const laptop = await loginAs(app, 'a@example.test', MAC_CHROME_UA);
    const unknown = await loginAs(app, 'a@example.test');
    const other = await loginAs(app, 'b@example.test', MAC_CHROME_UA);
    const [phoneId, laptopId, unknownId, otherId] = await Promise.all([
      sessionIdOf(phone.token),
      sessionIdOf(laptop.token),
      sessionIdOf(unknown.token),
      sessionIdOf(other.token),
    ]);

    // ① 목록: 본인의 살아 있는 세션만, 항목은 id·device_label·created_at·last_seen_at·current(expires_at 없음).
    const list = await req(app, 'GET', '/api/sessions', laptop);
    expect(list.statusCode).toBe(200);
    const parsed = sessionsResponseSchema.parse(list.json());
    for (const item of list.json<{ sessions: Record<string, unknown>[] }>().sessions) {
      expect(Object.keys(item).sort()).toEqual(['created_at', 'current', 'device_label', 'id', 'last_seen_at']);
    }
    const byId = new Map(parsed.sessions.map((s) => [s.id, s]));
    expect([...byId.keys()].sort()).toEqual([phoneId, laptopId, unknownId].sort());
    expect(byId.get(phoneId)).toMatchObject({ device_label: 'iPhone · Safari', current: false });
    expect(byId.get(laptopId)).toMatchObject({ device_label: 'Mac · Chrome', current: true });
    expect(byId.get(unknownId)).toMatchObject({ device_label: null, current: false });
    expect(list.body).not.toContain(otherId);
    expect(list.body).not.toContain(UA_CANARY);

    // 원격 로그아웃 대상(phone)과 유지 대상(laptop)에 WS·push 구독을 연다.
    await addPushSubscription(ids.a, phoneId);
    await addPushSubscription(ids.a, laptopId);
    await addPushSubscription(ids.b, otherId);
    const cid = await createChannel(app, laptop, 'general');
    const wsPhone = await connected(ctx.base, { token: phone.token });
    const wsLaptop = await connected(ctx.base, { token: laptop.token });
    ctx.clients.push(wsPhone, wsLaptop);
    expect(await subscribe(wsPhone, cid)).toMatchObject({ type: 'conversation.subscribed' });

    // ② 남의 세션·없는 세션: 같은 404(상태·본문·헤더 동일), 남의 세션 행·구독·WS 무변경.
    const otherBefore = await sessionRow(otherId);
    const foreign = await req(app, 'DELETE', `/api/sessions/${otherId}`, laptop);
    const missing = await req(app, 'DELETE', `/api/sessions/${randomUUID()}`, laptop);
    expect(foreign.statusCode).toBe(404);
    expect(shape(foreign)).toEqual(shape(missing));
    expect(await sessionRow(otherId)).toEqual(otherBefore);
    expect(await subscriptionCount(otherId)).toBe(1);
    expect((await req(app, 'GET', '/api/me', other)).statusCode).toBe(200);

    // 현재 세션 ID·UUID 형식 오류는 400.
    expect((await req(app, 'DELETE', `/api/sessions/${laptopId}`, laptop)).statusCode).toBe(400);
    expect((await req(app, 'DELETE', '/api/sessions/not-a-uuid', laptop)).statusCode).toBe(400);
    expect(await sessionRow(laptopId)).toMatchObject({ revoked_at: null });

    // ③ 본인 세션 폐기 → 204, 5초 안 그 세션의 WS 1008 close, 그 세션 push 구독 0, 다음 HTTP 401.
    // WS close는 커밋 후 sessionRevoked 이벤트로 즉시 일어난다(sweep 4초는 놓친 경우의 보조, TRD §5-3 5항).
    const revokedEvents: string[][] = [];
    app.authEvents.onSessionRevoked((sessionIds) => revokedEvents.push([...sessionIds]));
    const startedAt = performance.now();
    expect((await req(app, 'DELETE', `/api/sessions/${phoneId}`, laptop)).statusCode).toBe(204);
    expect(revokedEvents).toEqual([[phoneId]]);
    const { code, ms } = await closeLatency(wsPhone, startedAt);
    expect(code).toBe(WS_CLOSE_POLICY);
    expect(ms).toBeLessThanOrEqual(5000);
    expect(await subscriptionCount(phoneId)).toBe(0);
    expect((await req(app, 'GET', '/api/me', phone)).statusCode).toBe(401);
    // 다른 세션은 유지된다.
    expect(await subscriptionCount(laptopId)).toBe(1);
    expect(wsLaptop.socket.readyState).toBe(WebSocket.OPEN);
    expect((await req(app, 'GET', '/api/me', laptop)).statusCode).toBe(200);

    // 이미 폐기된 본인 세션은 204(멱등, DB 무변경). 만료된 본인 세션도 204이고 폐기 표시를 쓰지 않는다.
    const revokedRow = await sessionRow(phoneId);
    expect((await req(app, 'DELETE', `/api/sessions/${phoneId}`, laptop)).statusCode).toBe(204);
    expect(await sessionRow(phoneId)).toEqual(revokedRow);
    await ctx.conv.schema.pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [unknownId]);
    const expiredRow = await sessionRow(unknownId);
    expect((await req(app, 'DELETE', `/api/sessions/${unknownId}`, laptop)).statusCode).toBe(204);
    expect(await sessionRow(unknownId)).toEqual(expiredRow);
    // 목록에서 폐기·만료 세션은 빠진다.
    const after = sessionsResponseSchema.parse((await req(app, 'GET', '/api/sessions', laptop)).json());
    expect(after.sessions.map((s) => s.id)).toEqual([laptopId]);

    // 원문 UA는 DB·로그 어디에도 없고, 로그에 세션 ID·라벨도 없다(TM-HTTP-22, B6).
    const dump = await ctx.conv.schema.pool.query('SELECT row_to_json(s)::text AS j FROM sessions s');
    for (const { j } of dump.rows as { j: string }[]) {
      expect(j).not.toContain(UA_CANARY);
      expect(j).not.toContain('Mozilla');
      expect(j).not.toContain('17_4');
    }
    const logText = ctx.logs.join('\n');
    expect(ctx.logs.length).toBeGreaterThan(0);
    for (const needle of [UA_CANARY, 'Mozilla', phoneId, otherId, 'iPhone', 'Mac · Chrome']) expect(logText).not.toContain(needle);
  });

  it('같은 세션에 원격 로그아웃 10개를 동시에 보내도 전부 204이고 구독 삭제·WS close가 한 번의 효과로 끝난다', async () => {
    const { app, ids } = ctx.conv;
    const target = await loginAs(app, 'a@example.test', IPHONE_UA);
    const actor = await loginAs(app, 'a@example.test', MAC_CHROME_UA);
    const targetId = await sessionIdOf(target.token);
    const actorId = await sessionIdOf(actor.token);
    await addPushSubscription(ids.a, targetId);
    await addPushSubscription(ids.a, targetId);
    await addPushSubscription(ids.a, actorId);
    const ws = await connected(ctx.base, { token: target.token });
    ctx.clients.push(ws);
    const startedAt = performance.now();
    const results = await Promise.all(Array.from({ length: 10 }, () => req(app, 'DELETE', `/api/sessions/${targetId}`, actor)));
    expect(results.map((r) => r.statusCode)).toEqual(Array.from({ length: 10 }, () => 204));
    const { code, ms } = await closeLatency(ws, startedAt);
    expect(code).toBe(WS_CLOSE_POLICY);
    expect(ms).toBeLessThanOrEqual(5000);
    expect(await subscriptionCount(targetId)).toBe(0);
    expect(await subscriptionCount(actorId)).toBe(1);
    const rows = await ctx.conv.schema.pool.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM sessions WHERE id = $1', [targetId]);
    expect(rows.rows[0]?.revoked_at).toBeInstanceOf(Date);
    const deletes = ctx.logs.filter((line) => line.includes('"route":"/api/sessions/:id"'));
    expect(deletes).toHaveLength(10);
    expect(deletes.every((line) => line.includes('"status_code":204'))).toBe(true);
  });

  it('원격 로그아웃은 인증·CSRF 통제가 다른 상태 변경과 같다(미인증 401, CSRF 없음 403, 대상 무변경)', async () => {
    const { app } = ctx.conv;
    const target = await loginAs(app, 'a@example.test', IPHONE_UA);
    const actor = await loginAs(app, 'a@example.test', MAC_CHROME_UA);
    const targetId = await sessionIdOf(target.token);
    expect((await req(app, 'DELETE', `/api/sessions/${targetId}`)).statusCode).toBe(401);
    expect((await req(app, 'DELETE', `/api/sessions/${targetId}`, { token: actor.token, csrf: 'wrong' })).statusCode).toBe(403);
    expect(await sessionRow(targetId)).toMatchObject({ revoked_at: null });
    expect((await req(app, 'GET', '/api/me', target)).statusCode).toBe(200);
  });

  it('세션 UUID의 대소문자 변형도 소문자와 같은 판정이다(현재 세션 400·세션과 push 구독 유지, 본인 204, 남의 세션 404)', async () => {
    const { app, ids } = ctx.conv;
    const actor = await loginAs(app, 'a@example.test', MAC_CHROME_UA);
    const target = await loginAs(app, 'a@example.test', IPHONE_UA);
    const other = await loginAs(app, 'b@example.test', MAC_CHROME_UA);
    const [actorId, targetId, otherId] = await Promise.all([sessionIdOf(actor.token), sessionIdOf(target.token), sessionIdOf(other.token)]);
    await addPushSubscription(ids.a, actorId);
    // 첫 16진 문자만 대문자 — 원문·전체 대문자와 모두 다른 혼합 변형(무작위 위치 의존 없음).
    const mixed = (id: string): string => id.replace(/[a-f]/, (c) => c.toUpperCase());

    // 현재 세션: 대문자·혼합 대소문자 모두 400, 세션·push 구독 유지.
    for (const variant of [actorId.toUpperCase(), mixed(actorId)]) {
      expect(variant).not.toBe(actorId);
      expect((await req(app, 'DELETE', `/api/sessions/${variant}`, actor)).statusCode).toBe(400);
    }
    expect(await sessionRow(actorId)).toMatchObject({ revoked_at: null });
    expect((await req(app, 'GET', '/api/me', actor)).statusCode).toBe(200);
    expect(await subscriptionCount(actorId)).toBe(1);

    // 남의 세션 대문자: 소문자 요청과 같은 404(상태·본문·헤더), 남의 세션 무변경.
    const foreignUpper = await req(app, 'DELETE', `/api/sessions/${otherId.toUpperCase()}`, actor);
    const foreignLower = await req(app, 'DELETE', `/api/sessions/${otherId}`, actor);
    expect(foreignUpper.statusCode).toBe(404);
    expect(shape(foreignUpper)).toEqual(shape(foreignLower));
    expect((await req(app, 'GET', '/api/me', other)).statusCode).toBe(200);

    // 본인 다른 세션 대문자: 204 폐기.
    expect((await req(app, 'DELETE', `/api/sessions/${targetId.toUpperCase()}`, actor)).statusCode).toBe(204);
    expect((await req(app, 'GET', '/api/me', target)).statusCode).toBe(401);
    expect((await req(app, 'GET', '/api/me', actor)).statusCode).toBe(200);
  });
});
