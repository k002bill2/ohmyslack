import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SECURITY_HEADERS } from '../../src/http/security.js';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { download, mp3, png, uploadedId } from './att-harness.js';

/** FR-OPS-05 보조(TR-SEC-14, TRD §6-1·§5-1 S6): 다운로드 응답 헤더와 body 상한 예외의 범위. */
let ctx: ConvIntContext | undefined;

afterEach(async () => {
  await teardownConvInt(ctx);
  ctx = undefined;
});

describe('첨부 응답 헤더(TR-SEC-14)', () => {
  it('다운로드 응답은 nosniff·sandbox CSP·no-store·inline이고 선언이 아닌 판정 형식을 Content-Type으로 쓴다', async () => {
    ctx = await setupConvInt();
    const a = await as(ctx.app, 'a');
    const channel = await createChannel(ctx.app, a, 'hdr');
    for (const [bytes, mime] of [
      [png(), 'image/png'],
      [mp3(), 'audio/mpeg'],
    ] as const) {
      const id = await uploadedId(ctx.app, a, channel, bytes, mime);
      for (const range of [undefined, 'bytes=0-3']) {
        const res = await download(ctx.app, a, id, range === undefined ? {} : { range });
        expect(res.statusCode).toBe(range === undefined ? 200 : 206);
        expect(res.headers['content-type']).toBe(mime);
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['content-disposition']).toBe('inline');
        expect(res.headers['accept-ranges']).toBe('bytes');
      }
    }
    // 404 응답도 sandbox CSP·nosniff(존재 은폐 응답이 앱 CSP로 렌더되지 않게).
    const missing = await download(ctx.app, a, randomUUID());
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
  });

  it('업로드 body 상한 예외와 원시 바이트 파서는 업로드 라우트에만 있고 다른 라우트는 전역 64 KiB·S6 CSP를 유지한다', async () => {
    ctx = await setupConvInt();
    const a = await as(ctx.app, 'a');
    const channel = await createChannel(ctx.app, a, 'limits');
    const big = await req(ctx.app, 'POST', `/api/conversations/${channel}/messages`, a, { client_message_id: randomUUID(), body: 'x', pad: 'y'.repeat(70 * 1024) });
    expect(big.statusCode).toBe(413);
    const raw = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${channel}/messages`,
      headers: { ...(await headersOf(a)), 'content-type': 'image/png' },
      payload: png(),
    });
    expect(raw.statusCode).toBe(415);
    const health = await ctx.app.inject({ method: 'GET', url: '/api/healthz', headers: { host: 'ohmy.test' } });
    expect(health.headers['content-security-policy']).toBe(SECURITY_HEADERS['content-security-policy']);
  });
});

async function headersOf(session: { token: string; csrf: string }): Promise<Record<string, string>> {
  const { SESSION_COOKIE } = await import('../../src/modules/auth/routes.js');
  return { host: 'ohmy.test', origin: 'https://ohmy.test', cookie: `${SESSION_COOKIE}=${session.token}`, 'x-csrf-token': session.csrf };
}
