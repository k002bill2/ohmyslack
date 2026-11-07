import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runResetPassword } from '../../bin/lib/reset-password.js';
import { pipedIo } from '../auth/bootstrap-harness.js';
import { as, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { closeAll, connect, freePort, listen, type WsClient } from '../realtime/ws-int-harness.js';

/**
 * NC-21·TRD §5-1 S4: 프로세스 밖에서 세션이 폐기돼도(훅 없는 reset-password CLI, 수동 SQL) 열린 WS는 5초 안에 1008로 닫힌다.
 * 서버 hub는 같은 프로세스 이벤트를 받지 못하므로 주기 sweep이 DB를 다시 확인해야 한다(SECURITY_REVIEW_P1 F-2).
 */
const NEW_SECRET = 'reset horse battery staple 42';
const LIMIT_MS = 5000;

let ctx: ConvIntContext;
let base: string;
const clients: WsClient[] = [];

beforeEach(async () => {
  const port = await freePort();
  ctx = await setupConvInt({ extraHosts: [`127.0.0.1:${port}`] });
  base = await listen(ctx.app, port);
});

afterEach(async () => {
  closeAll(clients.splice(0));
  await teardownConvInt(ctx);
});

async function open(token: string): Promise<WsClient> {
  const client = await connect(base, { token });
  if (client === 'rejected') throw new Error('WS handshake 거부');
  clients.push(client);
  return client;
}

/** close가 오면 그 결과, 한도 안에 안 오면 'open'. */
async function closeWithin(client: WsClient, start: number): Promise<{ code: number; elapsed: number } | 'open'> {
  const timeout = new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), LIMIT_MS + 1500));
  const result = await Promise.race([client.closed, timeout]);
  return result === 'open' ? 'open' : { code: result.code, elapsed: result.at - start };
}

describe('자격 증명 복구 뒤 WS 종료 (NC-21, F-2)', () => {
  it('훅 없이 reset-password CLI를 실행하면 그 계정의 열린 WS가 5초 안에 1008로 닫히고 다른 계정은 유지된다', { timeout: 15_000 }, async () => {
    const a = await as(ctx.app, 'a');
    const b = await as(ctx.app, 'b');
    const wsA = await open(a.token);
    const wsB = await open(b.token);
    const start = performance.now();
    expect(await runResetPassword(['--email', 'a@example.test'], pipedIo(`${NEW_SECRET}\n`), ctx.schema.pool)).toBe(0);
    const closed = await closeWithin(wsA, start);
    expect(closed).not.toBe('open');
    if (closed === 'open') return;
    expect(closed.code).toBe(1008);
    expect(closed.elapsed).toBeLessThan(LIMIT_MS);
    expect(wsB.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('DB에서 직접 세션을 폐기해도(복원·수동 SQL) 5초 안에 1008로 닫힌다', { timeout: 15_000 }, async () => {
    const c = await as(ctx.app, 'c');
    const ws = await open(c.token);
    const start = performance.now();
    await ctx.schema.pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [ctx.ids.c]);
    const closed = await closeWithin(ws, start);
    expect(closed).not.toBe('open');
    if (closed === 'open') return;
    expect(closed.code).toBe(1008);
    expect(closed.elapsed).toBeLessThan(LIMIT_MS);
  });

  it('DB에서 직접 계정을 비활성화해도 5초 안에 1008로 닫힌다', { timeout: 15_000 }, async () => {
    const d = await as(ctx.app, 'd');
    const ws = await open(d.token);
    const start = performance.now();
    await ctx.schema.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [ctx.ids.d]);
    const closed = await closeWithin(ws, start);
    expect(closed).not.toBe('open');
    if (closed === 'open') return;
    expect(closed.code).toBe(1008);
    expect(closed.elapsed).toBeLessThan(LIMIT_MS);
  });
});
