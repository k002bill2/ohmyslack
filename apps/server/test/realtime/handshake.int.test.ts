import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { WS_PATH } from '../../src/shared.js';
import { ORIGIN } from '../support/auth-app.js';
import { as, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { freePort, listen } from './ws-int-harness.js';

/**
 * NC-03·NC-04·NC-10 WS handshake 우회 시도(W-09b 리뷰 d). harness `connect`는 Origin을 항상 채우므로
 * 헤더를 그대로 보내는 최소 클라이언트로 Origin 생략·변형, URL·Authorization token을 시도한다.
 */
let ctx: ConvIntContext;
let port: number;
const opened: WebSocket[] = [];

beforeEach(async () => {
  port = await freePort();
  ctx = await setupConvInt({ extraHosts: [`127.0.0.1:${port}`] });
  await listen(ctx.app, port);
});

afterEach(async () => {
  for (const s of opened.splice(0)) if (s.readyState <= 1) s.close();
  await teardownConvInt(ctx);
});

function attempt(url: string, headers: Record<string, string>): Promise<'open' | 'rejected'> {
  const socket = new WebSocket(url, { headers } as unknown as string[]);
  opened.push(socket);
  return new Promise((resolve) => {
    socket.addEventListener('open', () => resolve('open'));
    socket.addEventListener('error', () => resolve('rejected'));
  });
}

describe('WS handshake 우회', () => {
  it('FR-AUTH-06 Origin 없음·null·대소문자·경로 변형, 쿠키 없는 URL·Authorization token은 업그레이드되지 않고 정상 요청만 열린다', async () => {
    const a = await as(ctx.app, 'a');
    const url = `ws://127.0.0.1:${port}${WS_PATH}`;
    const cookie = `${SESSION_COOKIE}=${a.token}`;
    // 대조군: 같은 세션·정확한 Origin·허용 Host.
    expect(await attempt(url, { cookie, origin: ORIGIN })).toBe('open');
    expect(await attempt(url, { cookie })).toBe('rejected');
    expect(await attempt(url, { cookie, origin: 'null' })).toBe('rejected');
    expect(await attempt(url, { cookie, origin: ORIGIN.toUpperCase() })).toBe('rejected');
    expect(await attempt(url, { cookie, origin: `${ORIGIN}/` })).toBe('rejected');
    // token은 URL·Authorization으로 받지 않는다.
    expect(await attempt(`${url}?token=${a.token}`, { origin: ORIGIN })).toBe('rejected');
    expect(await attempt(url, { origin: ORIGIN, authorization: `Bearer ${a.token}` })).toBe('rejected');
  });
});
