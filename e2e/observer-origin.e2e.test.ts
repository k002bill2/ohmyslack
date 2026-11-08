import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/** DB 마이그레이션·로그인·HTTP·WS(개별 5초)를 한 테스트에서 하므로 기본 5초보다 넉넉히(Codex F-2 P2). */
const CASE_TIMEOUT_MS = 30_000;
import { SECRET, signIn } from '../apps/server/test/auth/members-int-harness.js';
import { login, ORIGIN } from '../apps/server/test/support/auth-app.js';
import { http, setupE2e, teardownE2e, type E2eContext } from './support/harness.js';
import { WsClient } from './support/ws-client.js';

/** 관측 모드(perf (b) 측정): 실제 리슨 주소를 허용 출처로 쓰고 웹 셸을 같은 출처로 서빙한다. 하네스 호출자도 그 출처를 쓴다. */
let ctx: E2eContext | undefined;
let dist: string | undefined;
afterEach(async () => {
  await teardownE2e(ctx);
  ctx = undefined;
  if (dist !== undefined) rmSync(dist, { recursive: true, force: true });
  dist = undefined;
});

describe('e2e 하네스 관측 모드 출처', () => {
  it('기본 모드는 기존 테스트 출처를 그대로 쓴다', async () => {
    ctx = await setupE2e();
    expect(ctx.origin).toBe(ORIGIN);
    const session = await signIn(ctx.app, 'a@example.test');
    await expect(http(ctx, 'GET', '/api/conversations', session)).resolves.toBeDefined();
  }, CASE_TIMEOUT_MS);

  it('관측 모드는 리슨 주소 출처로 셸 서빙·로그인·HTTP·WS가 되고 기본 출처는 거부된다', async () => {
    dist = mkdtempSync(join(tmpdir(), 'ohmy-observer-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    ctx = await setupE2e({ webDistDir: dist });
    expect(ctx.origin).toBe(ctx.baseUrl);

    const shell = await fetch(`${ctx.baseUrl}/`, { headers: { accept: 'text/html' } });
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<div id="root"');

    // 이 모드에서 기본 Host는 400, 기본 Origin은 403으로 거부된다(출처 전달이 실제로 필요함을 보인다).
    expect((await login(ctx.app, 'a@example.test', SECRET)).statusCode).toBe(400);
    const loginAs = (origin: string): Promise<Response> =>
      fetch(`${ctx?.baseUrl ?? ''}/api/auth/login`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@example.test', password: SECRET }),
      });
    expect((await loginAs(ORIGIN)).status).toBe(403);
    expect((await loginAs(ctx.origin)).status).toBe(200);
    const session = await signIn(ctx.app, 'a@example.test', undefined, ctx.origin);
    await expect(http(ctx, 'GET', '/api/conversations', session)).resolves.toBeDefined();
    await expect(http(ctx, 'POST', '/api/conversations', session, { kind: 'channel', name: 'observer-origin' })).resolves.toHaveProperty('id');

    await expect(WsClient.open(ctx.wsUrl, session)).rejects.toThrow();
    const ws = await WsClient.open(ctx.wsUrl, session, 5000, ctx.origin);
    await ws.close();
  }, CASE_TIMEOUT_MS);
});
