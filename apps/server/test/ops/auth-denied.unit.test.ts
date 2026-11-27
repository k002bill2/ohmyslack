import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { authDeniedMetric } from '../../src/modules/ops/auth-denied.js';
import { createMetricsRecorder, type MetricDims, type MetricsRecorder } from '../../src/modules/ops/metrics.js';
import { createMemoryAuthStore, HOST, login, testApp } from '../support/auth-app.js';

/** auth_denied 배선(PRD §10): 보안 가드·오류 처리기·로그인 거부 → action·reason enum, count=1. 원시 URL·쿠키 값은 쓰지 않는다. */
function capture() {
  const rows: MetricDims[] = [];
  const metrics = createMetricsRecorder({
    store: {
      async increment(_day, event, dims) {
        if (event === 'auth_denied') rows.push(dims);
      },
      pruneBefore: async () => 0,
    },
    clock: () => 0,
  });
  return { metrics, rows };
}

const throwing: MetricsRecorder = {
  record() {
    throw new Error('metrics down');
  },
};

async function scenario(metrics: MetricsRecorder | undefined) {
  const app = testApp({ authStore: createMemoryAuthStore(), ...(metrics === undefined ? {} : { metrics }) });
  const results = [
    await login(app, 'nobody@example.test', 'wrong password here'),
    await app.inject({ method: 'GET', url: '/api/me', headers: { host: HOST } }),
    await app.inject({ method: 'GET', url: '/api/me', headers: { host: HOST, cookie: `${SESSION_COOKIE}=OMS-CANARY-COOKIE-c20f9d` } }),
    await app.inject({ method: 'GET', url: '/api/me', headers: { host: 'evil.example.test' } }),
    await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: HOST, origin: 'https://evil.example.test' }, payload: {} }),
    await app.inject({ method: 'GET', url: '/api/healthz', headers: { host: HOST } }),
  ];
  await app.close();
  return results.map((r) => ({ status: r.statusCode, code: r.statusCode >= 400 ? r.json<{ error: { code: string } }>().error.code : 'ok' }));
}

describe('auth_denied 배선', () => {
  it('로그인 실패·세션 없음·세션 거부·Host·Origin 거부를 각각 1건씩 enum으로 기록하고 정상 요청은 0건', async () => {
    const { metrics, rows } = capture();
    await scenario(metrics);
    await metrics.idle();
    expect(rows).toEqual([
      { action: 'login', reason: 'bad_credentials', count: 1 },
      { action: 'session', reason: 'no_session', count: 1 },
      { action: 'session', reason: 'session_expired', count: 1 },
      { action: 'session', reason: 'host_not_allowed', count: 1 },
      { action: 'login', reason: 'origin_rejected', count: 1 },
    ]);
    expect(JSON.stringify(rows)).not.toContain('OMS-CANARY');
  });

  it('계측 기록기가 throw해도 응답 상태·오류 code는 계측 없을 때와 같다', async () => {
    const baseline = await scenario(undefined);
    expect(await scenario(throwing)).toEqual(baseline);
    expect(baseline.map((r) => r.code)).toEqual(['invalid_credentials', 'unauthenticated', 'unauthenticated', 'host_not_allowed', 'origin_rejected', 'ok']);
  });

  it('매핑: csrf·초대·WS·속도 제한은 정해진 enum, 접근 거부가 아닌 code는 기록하지 않는다', () => {
    expect(authDeniedMetric('csrf_rejected', '/api/conversations/:id/messages', true)).toEqual({ event: 'auth_denied', action: 'api', reason: 'forbidden', count: 1 });
    expect(authDeniedMetric('invite_invalid', '/api/invites/accept', false)).toEqual({ event: 'auth_denied', action: 'invite_accept', reason: 'invite_invalid', count: 1 });
    expect(authDeniedMetric('unauthenticated', '/api/ws', false)).toEqual({ event: 'auth_denied', action: 'ws_upgrade', reason: 'no_session', count: 1 });
    expect(authDeniedMetric('rate_limited', '/api/auth/login', false)).toEqual({ event: 'auth_denied', action: 'login', reason: 'rate_limited', count: 1 });
    expect(authDeniedMetric('forbidden', '/api/invites', true)).toEqual({ event: 'auth_denied', action: 'api', reason: 'forbidden', count: 1 });
    for (const code of ['not_found', 'invalid_request', 'idempotency_conflict', 'payload_too_large']) expect(authDeniedMetric(code, '/api/x', true)).toBeUndefined();
  });
});
