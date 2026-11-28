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
import { createMetricsRecorder, METRIC_MAX_KEYS, type MetricsRecorder, type MetricsStore } from '../../src/modules/ops/metrics.js';
import {
  CLIENT_METRIC_BODY_LIMIT_BYTES,
  CLIENT_METRIC_MAX_N,
  CLIENT_METRIC_MAX_RECORDS,
  COUNT_BUCKETS,
  DURATION_BUCKETS_MS,
  METRIC_ENUMS,
  meResponseSchema,
} from '../../src/shared.js';
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

/** 서로 다른 sync_result dims(최대 1980개). */
const SYNC_DIMS: readonly Record<string, unknown>[] = METRIC_ENUMS.sync_trigger.flatMap((trigger) =>
  METRIC_ENUMS.sync_outcome.flatMap((outcome) =>
    COUNT_BUCKETS.flatMap((caught_up_count) => DURATION_BUCKETS_MS.map((duration_ms) => ({ trigger, outcome, caught_up_count, duration_ms }))),
  ),
);

interface Probe {
  readonly app: FastifyInstance;
  readonly users: { readonly token: string; readonly csrf: string }[];
  readonly rows: { readonly event: string }[];
  readonly metrics: ReturnType<typeof createMetricsRecorder>;
  readonly clock: { now: number };
  readonly store: { down: boolean };
}

/** SEC 프로브 축약판: 실제 기록기(주기 flush 1시간 — 한 세대를 결정적으로 재현) + 사용자 여러 명. */
async function setupProbe(userCount: number): Promise<Probe> {
  const authStore = createMemoryAuthStore();
  for (let i = 0; i < userCount; i += 1) {
    const id = `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`;
    authStore.users.set(id, { id, emailNorm: `p${i}@ohmy.test`, displayName: `P${i}`, kind: 'human', passwordHash: hash, status: 'active', role: 'member' });
  }
  const rows: { event: string }[] = [];
  const state = { down: false };
  const metricsStore: MetricsStore = {
    async add(_day, event) {
      if (state.down) throw new Error('db down');
      rows.push({ event });
    },
    async pruneBefore() {
      return 0;
    },
  };
  const clock = { now: Date.UTC(2026, 10, 28, 9) };
  const metrics = createMetricsRecorder({ store: metricsStore, clock: () => clock.now, flushIntervalMs: 60 * 60 * 1000 });
  app = testApp({ authStore, clock: () => clock.now, metrics });
  const users: { token: string; csrf: string }[] = [];
  for (let i = 0; i < userCount; i += 1) {
    const res = await login(app, `p${i}@ohmy.test`, SECRET);
    expect(res.statusCode).toBe(200);
    users.push({ token: sessionCookie(res) ?? '', csrf: meResponseSchema.parse(res.json()).csrf_token });
  }
  await metrics.idle();
  rows.length = 0;
  return { app, users, rows, metrics, clock, store: state };
}

function probePost(p: Probe, user: { token: string; csrf: string }, records: unknown[], csrf = user.csrf) {
  return p.app.inject({
    method: 'POST',
    url: '/api/metrics',
    headers: { host: HOST, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${user.token}`, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    payload: JSON.stringify({ records }),
  });
}

/** 사용자 한 명이 한 창에 서로 다른 키 64개(n=1)를 32개씩 두 번 보낸다. */
async function sendKeys(p: Probe, user: { token: string; csrf: string }, dims: readonly Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < dims.length; i += CLIENT_METRIC_MAX_RECORDS) {
    const res = await probePost(p, user, dims.slice(i, i + CLIENT_METRIC_MAX_RECORDS).map((d) => ({ event: 'sync_result', dims: d, n: 1 })));
    expect(res.statusCode).toBe(202);
  }
}

describe('SEC V1 프로브(클라이언트 계측이 서버 auth_denied 자리를 빼앗지 못함)', () => {
  it('A: 여러 사용자가 한 flush 세대에 상한보다 많은 새 키를 보내도 뒤이은 auth_denied는 기록된다', async () => {
    const p = await setupProbe(3);
    let next = 0;
    for (let w = 0; w < 6; w += 1) {
      for (const user of p.users) {
        await sendKeys(p, user, SYNC_DIMS.slice(next, next + 64));
        next += 64;
      }
      p.clock.now += CLIENT_METRIC_WINDOW_MS;
    }
    expect(next).toBeGreaterThan(METRIC_MAX_KEYS);
    const first = p.users[0];
    if (first === undefined) throw new Error('no user');
    expect((await probePost(p, first, [], `${first.csrf}x`)).statusCode).toBe(403);
    await p.metrics.idle();
    expect(p.rows.filter((r) => r.event === 'auth_denied')).toHaveLength(1);
  });

  it('B: DB 장애 중 버퍼를 채운 뒤 복구돼도 장애 중 auth_denied는 기록된다', async () => {
    const p = await setupProbe(1);
    const user = p.users[0];
    if (user === undefined) throw new Error('no user');
    p.store.down = true;
    let next = 0;
    for (let w = 0; w < 18; w += 1) {
      await sendKeys(p, user, SYNC_DIMS.slice(next, next + 64));
      next += 64;
      p.clock.now += CLIENT_METRIC_WINDOW_MS;
      await p.metrics.idle();
    }
    expect(next).toBeGreaterThan(METRIC_MAX_KEYS);
    expect((await probePost(p, user, [], `${user.csrf}x`)).statusCode).toBe(403);
    p.store.down = false;
    await p.metrics.idle();
    expect(p.rows.filter((r) => r.event === 'auth_denied')).toHaveLength(1);
  });
});
