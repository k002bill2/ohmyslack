import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOG_CANARIES } from '../../../../tools/log-canaries.js';
import { SESSION_COOKIE } from '../../src/modules/auth/guards.js';
import { CLIENT_METRIC_MAX_PER_MINUTE } from '../../src/modules/ops/client-metrics.js';
import { CLIENT_METRIC_MAX_N, meResponseSchema } from '../../src/shared.js';
import { HOST, login, ORIGIN, sessionCookie } from '../support/auth-app.js';
import { setupAuthInt, teardownAuthInt, type AuthIntContext } from '../auth/auth-int-harness.js';

/** FR-OPS-03 2단계: POST /api/metrics가 클라이언트 3종만 metric_daily에 정확히 n만큼 올린다(실DB). */
const SECRET = 'client-metrics-secret-01';
const EMAIL = 'cm@example.test';
let ctx: AuthIntContext | undefined;

beforeEach(async () => {
  ctx = await setupAuthInt(EMAIL, SECRET);
});

afterEach(async () => {
  await teardownAuthInt(ctx);
  ctx = undefined;
});

interface Row {
  readonly event: string;
  readonly dims: Record<string, unknown>;
  readonly count: number;
}

async function rows(c: AuthIntContext): Promise<Row[]> {
  await c.metrics.idle();
  const res = await c.schema.pool.query<Row>('SELECT event, dims, count FROM metric_daily ORDER BY event, count');
  return res.rows;
}

async function session(c: AuthIntContext): Promise<{ token: string; csrf: string }> {
  const res = await login(c.app, EMAIL, SECRET);
  expect(res.statusCode).toBe(200);
  return { token: sessionCookie(res) ?? '', csrf: meResponseSchema.parse(res.json()).csrf_token };
}

function post(c: AuthIntContext, s: { token: string; csrf: string }, payload: unknown, headers: Record<string, string> = {}) {
  return c.app.inject({
    method: 'POST',
    url: '/api/metrics',
    headers: { host: HOST, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${s.token}`, 'x-csrf-token': s.csrf, ...headers },
    payload: payload as Record<string, unknown>,
  });
}

const SYNC = { event: 'sync_result', dims: { trigger: 'foreground', outcome: 'ok', caught_up_count: 5, duration_ms: 250 }, n: 7 };

describe('POST /api/metrics → metric_daily (Postgres)', () => {
  it('클라이언트 레코드는 metric_daily에 정확히 n만큼 반영되고, 위조·카나리아 레코드는 0행이다', async () => {
    const c = ctx as AuthIntContext;
    const s = await session(c);
    const before = await rows(c);
    const canaryRecords = Object.values(LOG_CANARIES).flatMap((canary) => [
      { event: 'client_state', dims: { state: canary, count: 1 }, n: 1 },
      { event: 'client_state', dims: { state: 'offline', count: 1, message_id: canary }, n: 1 },
    ]);
    const forged = { event: 'push_send_result', dims: { outcome: 'sent' }, n: 50 };
    const res = await post(c, s, { records: [SYNC, forged, ...canaryRecords.slice(0, 20)] });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('{"status":"accepted"}');
    expect((await post(c, s, { records: [{ ...SYNC, n: 3 }] })).statusCode).toBe(202);
    const after = await rows(c);
    expect(after.filter((r) => !before.some((b) => b.event === r.event && JSON.stringify(b.dims) === JSON.stringify(r.dims)))).toEqual([
      { event: 'sync_result', dims: { trigger: 'foreground', outcome: 'ok', caught_up_count: 5, duration_ms: 250 }, count: 10 },
    ]);
    expect(after.some((r) => r.event === 'push_send_result')).toBe(false);
    const dump = JSON.stringify(after) + c.logs.join('\n') + res.body;
    for (const canary of Object.values(LOG_CANARIES)) expect(dump).not.toContain(canary);
  });

  it('미인증·다른 Origin 요청은 거부되고 클라이언트 이벤트 행은 0이다', async () => {
    const c = ctx as AuthIntContext;
    const s = await session(c);
    expect((await post(c, s, { records: [SYNC] }, { cookie: '' })).statusCode).toBe(401);
    expect((await post(c, s, { records: [SYNC] }, { origin: 'https://evil.test' })).statusCode).toBe(403);
    expect((await rows(c)).filter((r) => r.event === 'sync_result')).toEqual([]);
  });

  it('분당 상한을 넘는 몫은 metric_daily에 반영되지 않는다', async () => {
    const c = ctx as AuthIntContext;
    const s = await session(c);
    const state = { event: 'client_state', dims: { state: 'reconnecting', count: 1 }, n: CLIENT_METRIC_MAX_N };
    for (let i = 0; i < 5; i += 1) expect((await post(c, s, { records: [state] })).statusCode).toBe(202);
    const counted = (await rows(c)).filter((r) => r.event === 'client_state');
    expect(counted).toEqual([{ event: 'client_state', dims: { state: 'reconnecting', count: 1 }, count: CLIENT_METRIC_MAX_PER_MINUTE }]);
  });
});
