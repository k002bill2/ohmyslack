import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WS_CLOSE_POLICY } from '../../src/shared.js';
import { as, createChannel, req } from '../conversations/conv-int-harness.js';
import { closeLatency, connect, setupWsInt, subscribe, type WsIntContext } from '../realtime/ws-int-harness.js';
import { login } from '../support/auth-app.js';

/** FR-AUTH-02 세션 유지·로그아웃 WS 5초 close(TRD §5, TR-SEC-04). */
let ws: WsIntContext;

beforeEach(async () => {
  ws = await setupWsInt();
});

afterEach(async () => {
  await ws.teardown();
});

describe('세션', () => {
  it('FR-AUTH-02 로그인 세션은 새로고침 후 유지되고 잘못된 자격 증명은 거부되며 로그아웃 세션은 HTTP 401·WS 5초 내 종료이고 다른 기기 세션과 5분 뒤 유효 세션 복귀는 유지된다', async () => {
    const { app } = ws.conv;
    const deviceA = await as(app, 'a');
    const deviceB = await as(app, 'a');
    // 새로고침: 같은 쿠키로 /api/me 재요청이 유지된다.
    expect((await req(app, 'GET', '/api/me', deviceA)).statusCode).toBe(200);
    expect((await req(app, 'GET', '/api/me', deviceA)).statusCode).toBe(200);
    expect((await login(app, 'a@example.test', 'wrong password!!')).statusCode).toBe(401);

    const cid = await createChannel(app, deviceA, 'general');
    const wsA = await ws.open(deviceA.token);
    const wsB = await ws.open(deviceB.token);
    expect(await subscribe(wsA, cid)).toMatchObject({ type: 'conversation.subscribed' });
    expect(await subscribe(wsB, cid)).toMatchObject({ type: 'conversation.subscribed' });

    const startedAt = performance.now();
    expect((await req(app, 'POST', '/api/auth/logout', deviceA)).statusCode).toBe(204);
    const { code, ms } = await closeLatency(wsA, startedAt);
    expect(code).toBe(WS_CLOSE_POLICY);
    expect(ms).toBeLessThanOrEqual(5000);
    expect((await req(app, 'GET', '/api/me', deviceA)).statusCode).toBe(401);
    expect(await connect(ws.base, { token: deviceA.token })).toBe('rejected');

    // 다른 기기 세션은 유지된다: HTTP 200, WS 열린 채로 새 이벤트를 받는다.
    expect((await req(app, 'GET', '/api/me', deviceB)).statusCode).toBe(200);
    expect(wsB.socket.readyState).toBe(WebSocket.OPEN);
    // 5분 뒤 복귀: 유효 세션은 그대로 인증된다(30일 sliding, 가짜 시간 대신 last_seen을 5분 전으로 되돌린다).
    await ws.conv.schema.pool.query("UPDATE sessions SET last_seen_at = last_seen_at - interval '5 minutes' WHERE revoked_at IS NULL");
    expect((await req(app, 'GET', '/api/me', deviceB)).statusCode).toBe(200);
    expect(await subscribe(wsB, cid, 0)).toMatchObject({ type: 'conversation.subscribed' });
  });

  it('S7 만료 시각에 열린 WS는 1008로 닫히고 WS 트래픽은 세션을 연장하지 않는다', async () => {
    const { app, schema } = ws.conv;
    const a = await as(app, 'a');
    const cid = await createChannel(app, a, 'general');
    const expiresBefore = await schema.pool.query<{ e: Date }>('SELECT expires_at AS e FROM sessions WHERE revoked_at IS NULL');
    const client = await ws.open(a.token);
    for (let i = 0; i < 3; i += 1) await subscribe(client, cid);
    const after = await schema.pool.query<{ e: Date }>('SELECT expires_at AS e FROM sessions WHERE revoked_at IS NULL');
    expect(after.rows).toEqual(expiresBefore.rows);
    // 만료를 1초 뒤로 당긴 새 연결: 만료 타이머가 1008로 닫는다.
    await schema.pool.query("UPDATE sessions SET expires_at = now() + interval '1 second'");
    const short = await ws.open(a.token);
    const startedAt = performance.now();
    const { code, ms } = await closeLatency(short, startedAt);
    expect(code).toBe(WS_CLOSE_POLICY);
    expect(ms).toBeLessThanOrEqual(5000);
  });
});
