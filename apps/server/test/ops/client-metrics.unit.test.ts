import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LOG_CANARIES } from '../../../../tools/log-canaries.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import {
  CLIENT_METRIC_MAX_PER_MINUTE,
  CLIENT_METRIC_MAX_TRACKED,
  CLIENT_METRIC_WINDOW_MS,
  createClientMetricLimiter,
} from '../../src/modules/ops/client-metrics.js';
import { createOpsLogger } from '../../src/modules/ops/logger.js';
import type { MetricsRecorder } from '../../src/modules/ops/metrics.js';
import { CLIENT_METRIC_BODY_LIMIT_BYTES, CLIENT_METRIC_MAX_N, CLIENT_METRIC_MAX_RECORDS, meResponseSchema } from '../../src/shared.js';
import { createMemoryAuthStore, HOST, login, ORIGIN, sessionCookie, testApp } from '../support/auth-app.js';
import { SESSION_COOKIE } from '../../src/modules/auth/guards.js';

const SECRET = randomBytes(18).toString('base64url');
const USER_ID = '22222222-2222-4222-8222-222222222222';
let hash: string;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  hash = await hashPassword(SECRET);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Recorded {
  readonly input: Readonly<Record<string, unknown>>;
  readonly n: number | undefined;
}

interface Ctx {
  readonly app: FastifyInstance;
  readonly recorded: Recorded[];
  readonly logs: string[];
  readonly token: string;
  readonly csrf: string;
  clock: { now: number };
}

async function setup(recorder?: MetricsRecorder): Promise<Ctx> {
  const store = createMemoryAuthStore();
  store.users.set(USER_ID, { id: USER_ID, emailNorm: 'm@ohmy.test', displayName: 'M', kind: 'human', passwordHash: hash, status: 'active', role: 'member' });
  const recorded: Recorded[] = [];
  const logs: string[] = [];
  const clock = { now: Date.UTC(2026, 10, 28, 9) };
  const metrics: MetricsRecorder = recorder ?? { record: (input, n) => void recorded.push({ input, n }) };
  app = testApp({ authStore: store, clock: () => clock.now, metrics, logger: createOpsLogger((line) => logs.push(line)) });
  const res = await login(app, 'm@ohmy.test', SECRET);
  expect(res.statusCode).toBe(200);
  // 로그인 경로의 계측(있다면)은 이 테스트 대상이 아니다.
  recorded.length = 0;
  return { app, recorded, logs, token: sessionCookie(res) ?? '', csrf: meResponseSchema.parse(res.json()).csrf_token, clock };
}

function post(c: Ctx, payload: unknown, headers: Record<string, string> = {}) {
  return c.app.inject({
    method: 'POST',
    url: '/api/metrics',
    headers: { host: HOST, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${c.token}`, 'x-csrf-token': c.csrf, 'content-type': 'application/json', ...headers },
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

const SYNC = { event: 'sync_result', dims: { trigger: 'reconnect', outcome: 'ok', caught_up_count: 20, duration_ms: 500 }, n: 3 };
const STATE = { event: 'client_state', dims: { state: 'offline', count: 1 }, n: 2 };

describe('POST /api/metrics (클라이언트 계측 수집)', () => {
  it('클라이언트 3종을 n만큼 기록하고 202 고정 본문·no-store로 답한다', async () => {
    const c = await setup();
    const res = await post(c, { records: [SYNC, STATE, { event: 'read_sync_result', dims: { outcome: 'mismatch', duration_ms: 0 }, n: 1 }] });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(c.recorded).toEqual([
      { input: { event: 'sync_result', trigger: 'reconnect', outcome: 'ok', caught_up_count: 20, duration_ms: 500 }, n: 3 },
      { input: { event: 'client_state', state: 'offline', count: 1 }, n: 2 },
      { input: { event: 'read_sync_result', outcome: 'mismatch', duration_ms: 0 }, n: 1 },
    ]);
  });

  it('미인증 401·잘못된 Origin 403·CSRF 불일치 403이고 계측은 0이다', async () => {
    const c = await setup();
    const body = { records: [SYNC] };
    expect((await post(c, body, { cookie: '' })).statusCode).toBe(401);
    for (const origin of ['https://evil.test', 'null']) expect((await post(c, body, { origin })).statusCode).toBe(403);
    expect((await post(c, body, { 'x-csrf-token': `${c.csrf}x` })).statusCode).toBe(403);
    // 가드 거부 자체는 서버 auth_denied로만 남고, 클라이언트 레코드는 하나도 기록되지 않는다.
    expect(c.recorded.filter((r) => r.input.event !== 'auth_denied')).toEqual([]);
    expect(c.recorded.every((r) => r.n === undefined)).toBe(true);
  });

  it('서버 관찰 4종 위조·dims 안 event 덮어쓰기·allowlist 밖 키·카나리아 값은 버리고 나머지만 기록한다', async () => {
    const c = await setup();
    const forged = [
      { event: 'auth_denied', dims: { action: 'login', reason: 'bad_credentials', count: 1 }, n: 1 },
      { event: 'message_send_result', dims: { outcome: 'ok', conv_kind: 'dm', has_thread: false, duration_ms: 0 }, n: 1 },
      { event: 'push_send_result', dims: { outcome: 'sent' }, n: 1 },
      { event: 'bot_delivery_result', dims: { direction: 'in', outcome: 'ok', has_attachment: false, duration_ms: 0 }, n: 1 },
      { ...STATE, dims: { ...STATE.dims, event: 'push_send_result' } },
      ...Object.values(LOG_CANARIES).flatMap((canary) => [
        { ...STATE, dims: { state: canary, count: 1 } },
        { ...STATE, dims: { ...STATE.dims, url: canary } },
        { ...STATE, dims: { ...STATE.dims, user_id: canary } },
      ]),
    ].slice(0, CLIENT_METRIC_MAX_RECORDS - 1);
    const res = await post(c, { records: [...forged, STATE] });
    expect(res.statusCode).toBe(202);
    expect(c.recorded).toEqual([{ input: { event: 'client_state', state: 'offline', count: 1 }, n: 2 }]);
    for (const canary of Object.values(LOG_CANARIES)) {
      expect(res.body).not.toContain(canary);
      expect(c.logs.join('\n')).not.toContain(canary);
    }
  });

  it('n 범위(1..상한)·records 길이 상한·본문 크기 상한을 지킨다', async () => {
    const c = await setup();
    const res = await post(c, { records: [{ ...STATE, n: 0 }, { ...STATE, n: CLIENT_METRIC_MAX_N + 1 }, { ...STATE, n: 1.5 }, { ...STATE, n: CLIENT_METRIC_MAX_N }] });
    expect(res.statusCode).toBe(202);
    expect(c.recorded.map((r) => r.n)).toEqual([CLIENT_METRIC_MAX_N]);
    c.recorded.length = 0;
    const tooMany = await post(c, { records: Array.from({ length: CLIENT_METRIC_MAX_RECORDS + 1 }, () => STATE) });
    expect(tooMany.statusCode).toBe(400);
    const big = await post(c, { records: [{ ...STATE, dims: { ...STATE.dims, pad: 'x'.repeat(CLIENT_METRIC_BODY_LIMIT_BYTES) } }] });
    expect(big.statusCode).toBe(413);
    for (const broken of ['{"records":', '[]', '{"records":{}}', '{"records":[],"extra":1}']) expect((await post(c, broken)).statusCode).toBe(400);
    expect(c.recorded).toEqual([]);
  });

  it('사용자별 분당 증분 합 상한을 넘는 몫은 버리고, 신호는 창당 1회, 다음 창에 회복한다', async () => {
    const c = await setup();
    const batch = { records: Array.from({ length: 4 }, () => ({ ...STATE, n: CLIENT_METRIC_MAX_N })) };
    expect((await post(c, batch)).statusCode).toBe(202);
    expect((await post(c, batch)).statusCode).toBe(202);
    const total = c.recorded.reduce((sum, r) => sum + (r.n ?? 0), 0);
    expect(total).toBe(CLIENT_METRIC_MAX_PER_MINUTE);
    expect(c.logs.filter((l) => l.includes('metric_client_limited'))).toHaveLength(1);
    c.clock.now += CLIENT_METRIC_WINDOW_MS;
    c.recorded.length = 0;
    expect((await post(c, { records: [STATE] })).statusCode).toBe(202);
    expect(c.recorded).toHaveLength(1);
  });

  it('기록기 예외는 응답을 바꾸지 않는다', async () => {
    const c = await setup({ record: () => { throw new Error(LOG_CANARIES.body ?? 'boom'); } });
    const res = await post(c, { records: [SYNC] });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted' });
  });

  it('access 레지스트리에 account 라우트로 등록된다', async () => {
    const c = await setup();
    expect(c.app.accessRoutes.map((r) => `${r.method} ${r.url} ${r.access}`)).toContain('POST /api/metrics account');
  });
});

describe('createClientMetricLimiter', () => {
  it('추적 사용자 수 상한: 만료 창은 정리하고, 살아 있는 창으로 가득 차면 새 사용자 몫은 0', () => {
    let now = 0;
    const limiter = createClientMetricLimiter(() => now);
    for (let i = 0; i < CLIENT_METRIC_MAX_TRACKED; i += 1) expect(limiter.take(`u${i}`, 1)).toBe(1);
    expect(limiter.take('new', 1)).toBe(0);
    now += CLIENT_METRIC_WINDOW_MS;
    expect(limiter.take('new', 1)).toBe(1);
  });

  it('남은 몫만큼만 떼어 준다', () => {
    const limiter = createClientMetricLimiter(() => 0);
    expect(limiter.take('u', CLIENT_METRIC_MAX_PER_MINUTE - 10)).toBe(CLIENT_METRIC_MAX_PER_MINUTE - 10);
    expect(limiter.take('u', 25)).toBe(10);
    expect(limiter.take('u', 1)).toBe(0);
  });
});
