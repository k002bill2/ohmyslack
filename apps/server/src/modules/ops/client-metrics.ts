import type { FastifyInstance } from 'fastify';
import { markAccountGuard } from '../../http/access.js';
import { HttpError } from '../../http/errors.js';
import { accountGuard, requireAuth } from '../auth/guards.js';
import type { AuthService } from '../auth/service.js';
import { CLIENT_METRIC_BODY_LIMIT_BYTES, clientMetricBatchSchema, toClientMetric } from '../../shared.js';
import type { MetricsRecorder } from './metrics.js';

/**
 * 클라이언트 계측 수집(정본: PRD §10 2단계, TRD 391행·TR-SEC-09, DEV_DESIGN FR-OPS-03). `POST /api/metrics`는 메인 리스너의
 * 쿠키 세션 라우트다(봇 리스너 미등록). Host·Origin(onRequest) → 세션·CSRF(accountGuard) 가드를 다른 쓰기 라우트와 똑같이 거친다.
 * - 클라이언트 3종만 받는다(서버 관찰 4종 위조 거부). 레코드는 shared allowlist로 개별 검증해 위반분만 버린다.
 * - 응답은 형식이 맞으면 언제나 202 + 고정 본문 — 입력을 반향하지 않고, 버린 레코드가 있어도 클라이언트가 재전송 루프에 빠지지 않게.
 * - 사용자별 분당 증분 합 상한을 넘는 몫은 버린다. 계측 실패는 응답을 바꾸지 않는다. 로그에 본문·dims·ID 없음.
 */

/**
 * 사용자별 분당 증분(n 합) 상한. 정상 클라이언트는 60초마다 한 번, 실제로 나타난 조합 몇 개 × 몇 회를 보낸다(수십 이하).
 * 오프라인 뒤 재합산분까지 받을 여유를 두되, 남용 시 하루 집계를 사용자당 분당 이 값으로 묶는다.
 */
export const CLIENT_METRIC_MAX_PER_MINUTE = 300;
export const CLIENT_METRIC_WINDOW_MS = 60_000;
/** 상한 카운터 키(사용자) 수 상한 — 개인용 메신저 사용자 수보다 넉넉하다. 가득 차면 만료 창을 정리하고, 그래도 차 있으면 새 사용자 몫을 버린다(메모리 유계). */
export const CLIENT_METRIC_MAX_TRACKED = 256;
/** 응답 본문(고정). */
export const CLIENT_METRIC_ACCEPTED = Object.freeze({ status: 'accepted' as const });

export interface ClientMetricLimiter {
  /** 이번 창에서 쓸 수 있는 만큼 떼어 준다(0..n). 초과분은 버려진다. */
  take(userKey: string, n: number): number;
}

/**
 * 고정 창(60초) 카운터. 검사와 기록이 같은 동기 구간이라 동시 요청에도 경쟁이 없다(bots/rate-limit.ts와 같은 방식).
 * onLimited는 창 하나에 한 번만 부른다(고정 코드 신호 — 초과 요청 수만큼 로그가 늘지 않게).
 */
export function createClientMetricLimiter(clock: () => number, onLimited: () => void = () => undefined): ClientMetricLimiter {
  const windows = new Map<string, { start: number; used: number }>();
  let reportedWindow = -1;
  const signal = (now: number): void => {
    const windowIndex = Math.floor(now / CLIENT_METRIC_WINDOW_MS);
    if (windowIndex === reportedWindow) return;
    reportedWindow = windowIndex;
    try {
      onLimited();
    } catch {
      // 신호 실패는 응답 경로로 올리지 않는다.
    }
  };
  const prune = (now: number): void => {
    for (const [key, w] of windows) if (now - w.start >= CLIENT_METRIC_WINDOW_MS) windows.delete(key);
  };
  return {
    take(userKey, n) {
      const now = clock();
      let w = windows.get(userKey);
      if (w !== undefined && now - w.start >= CLIENT_METRIC_WINDOW_MS) w = undefined;
      if (w === undefined) {
        if (!windows.has(userKey) && windows.size >= CLIENT_METRIC_MAX_TRACKED) prune(now);
        if (!windows.has(userKey) && windows.size >= CLIENT_METRIC_MAX_TRACKED) {
          signal(now);
          return 0;
        }
        w = { start: now, used: 0 };
        windows.set(userKey, w);
      }
      const granted = Math.max(0, Math.min(n, CLIENT_METRIC_MAX_PER_MINUTE - w.used));
      w.used += granted;
      if (granted < n) signal(now);
      return granted;
    },
  };
}

export interface ClientMetricsDeps {
  readonly auth: AuthService;
  readonly metrics: MetricsRecorder;
  readonly limiter: ClientMetricLimiter;
}

export function registerClientMetricsRoutes(app: FastifyInstance, deps: ClientMetricsDeps): void {
  const { metrics, limiter } = deps;
  app.post(
    '/api/metrics',
    { config: { access: 'account' }, preHandler: markAccountGuard(accountGuard(deps.auth)), bodyLimit: CLIENT_METRIC_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const userKey = requireAuth(request).user.id;
      const batch = clientMetricBatchSchema.safeParse(request.body);
      if (!batch.success) throw new HttpError(400, 'invalid_request');
      for (const raw of batch.data.records) {
        try {
          const metric = toClientMetric(raw);
          if (metric === undefined) continue;
          const granted = limiter.take(userKey, metric.n);
          if (granted > 0) metrics.record(metric.record, granted);
        } catch {
          // 계측 실패는 응답을 바꾸지 않는다.
        }
      }
      return reply.code(202).send(CLIENT_METRIC_ACCEPTED);
    },
  );
}
