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
/**
 * 사용자별 창당 서로 다른 (event, dims) 키 상한(SEC R2, 다층). 웹 정상 클라이언트 버퍼 상한(웹 METRIC_MAX_KEYS = 64)과 같다 —
 * n 합 상한(300)만으로는 n=1 레코드 300개 = 새 키 300개라, 한 사용자가 서버 기록기 버퍼에 넣는 새 키 폭을 정상 클라이언트 수준으로 묶는다.
 * 키 집합 메모리는 사용자 CLIENT_METRIC_MAX_TRACKED(256) × 64로 유계다.
 */
export const CLIENT_METRIC_MAX_KEYS_PER_WINDOW = 64;
/** 상한 카운터 키(사용자) 수 상한 — 개인용 메신저 사용자 수보다 넉넉하다. 가득 차면 만료 창을 정리하고, 그래도 차 있으면 새 사용자 몫을 버린다(메모리 유계). */
export const CLIENT_METRIC_MAX_TRACKED = 256;
/** 응답 본문(고정). */
export const CLIENT_METRIC_ACCEPTED = Object.freeze({ status: 'accepted' as const });

export interface ClientMetricLimiter {
  /**
   * 이번 창에서 쓸 수 있는 만큼 떼어 준다(0..n). 초과분은 버려진다. metricKey는 (event, dims) 식별 문자열 — 이번 창에서 처음 보는
   * 키가 CLIENT_METRIC_MAX_KEYS_PER_WINDOW개를 넘으면 0이다(이미 본 키는 n 합 상한 안에서 계속 받는다).
   */
  take(userKey: string, metricKey: string, n: number): number;
}

/**
 * 고정 창(60초) 카운터. 검사와 기록이 같은 동기 구간이라 동시 요청에도 경쟁이 없다(bots/rate-limit.ts와 같은 방식).
 * onLimited는 창 하나에 한 번만 부른다(고정 코드 신호 — 초과 요청 수만큼 로그가 늘지 않게).
 * 고정 창이라 창 경계에서는 사용자당 짧은 시간에 상한의 2배(앞 창 끝 + 새 창 시작: 증분 600·새 키 128)까지 들어올 수 있다 —
 * 의도된 단순화다. 서버 4종 자리는 기록기의 METRIC_MAX_CLIENT_KEYS가 따로 보장하므로(SEC R1) 이 경계 폭은 집계 부풀림 이상으로 번지지 않는다.
 */
export function createClientMetricLimiter(clock: () => number, onLimited: () => void = () => undefined): ClientMetricLimiter {
  const windows = new Map<string, { start: number; used: number; readonly keys: Set<string> }>();
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
    take(userKey, metricKey, n) {
      const now = clock();
      let w = windows.get(userKey);
      if (w !== undefined && now - w.start >= CLIENT_METRIC_WINDOW_MS) w = undefined;
      if (w === undefined) {
        if (!windows.has(userKey) && windows.size >= CLIENT_METRIC_MAX_TRACKED) prune(now);
        if (!windows.has(userKey) && windows.size >= CLIENT_METRIC_MAX_TRACKED) {
          signal(now);
          return 0;
        }
        w = { start: now, used: 0, keys: new Set() };
        windows.set(userKey, w);
      }
      if (!w.keys.has(metricKey) && w.keys.size >= CLIENT_METRIC_MAX_KEYS_PER_WINDOW) {
        signal(now);
        return 0;
      }
      const granted = Math.max(0, Math.min(n, CLIENT_METRIC_MAX_PER_MINUTE - w.used));
      w.used += granted;
      if (granted > 0) w.keys.add(metricKey);
      if (granted < n) signal(now);
      return granted;
    },
  };
}

/** (event, dims) 식별 문자열: dims 키를 정렬해 같은 조합이 키 순서와 무관하게 한 키가 되게 한다(기록기 bufferKey와 같은 규칙). */
function metricKey(record: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(Object.keys(record).sort().map((k) => [k, record[k]]));
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
          const granted = limiter.take(userKey, metricKey(metric.record), metric.n);
          if (granted > 0) metrics.record(metric.record, granted);
        } catch {
          // 계측 실패는 응답을 바꾸지 않는다.
        }
      }
      return reply.code(202).send(CLIENT_METRIC_ACCEPTED);
    },
  );
}
