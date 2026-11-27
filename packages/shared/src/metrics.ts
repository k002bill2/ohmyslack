import { z } from 'zod';

/**
 * 개인정보 없는 계측 허용 목록(정본: PRD §10, DEV_DESIGN §6-2 FR-OPS-03·TR-SEC-09).
 * 이벤트별 고정 필드만 허용한다. 본문·이메일·이름·IP·UA·각종 ID·URL·쿠키·토큰·원시 오류는 넣을 수 없다.
 */
export const METRIC_ALLOWLIST = Object.freeze({
  message_send_result: Object.freeze(['outcome', 'conv_kind', 'has_thread', 'duration_ms'] as const),
  sync_result: Object.freeze(['trigger', 'outcome', 'caught_up_count', 'duration_ms'] as const),
  read_sync_result: Object.freeze(['outcome', 'duration_ms'] as const),
  auth_denied: Object.freeze(['action', 'reason', 'count'] as const),
  client_state: Object.freeze(['state', 'count'] as const),
  bot_delivery_result: Object.freeze(['direction', 'outcome', 'has_attachment', 'duration_ms'] as const),
  push_send_result: Object.freeze(['outcome'] as const),
});

export type MetricEvent = keyof typeof METRIC_ALLOWLIST;

/**
 * enum 필드의 사전 정의 값(PRD §10 "임의 문자열 대신 사전 정의 enum"). 정본 문서는 값 목록을 정하지 않아(필드명은 합의 전 가정)
 * 도메인 값(대화 종류 `channel`·`dm`, 보안 가드 거부 사유 등)에서 닫힌 집합으로 정했다. 목록 밖 값은 기록하지 않는다.
 */
export const METRIC_ENUMS = Object.freeze({
  send_outcome: Object.freeze(['ok', 'duplicate', 'rejected', 'failed', 'timeout'] as const),
  conv_kind: Object.freeze(['channel', 'dm'] as const),
  sync_trigger: Object.freeze(['connect', 'reconnect', 'foreground', 'manual'] as const),
  sync_outcome: Object.freeze(['ok', 'partial', 'resync_required', 'failed', 'timeout'] as const),
  read_sync_outcome: Object.freeze(['ok', 'mismatch', 'failed'] as const),
  auth_action: Object.freeze(['login', 'session', 'invite_accept', 'api', 'ws_upgrade'] as const),
  auth_reason: Object.freeze([
    'bad_credentials',
    'rate_limited',
    'no_session',
    'session_expired',
    'forbidden',
    'origin_rejected',
    'host_not_allowed',
    'invite_invalid',
  ] as const),
  client_state: Object.freeze(['online', 'offline', 'reconnecting', 'resync_error'] as const),
  bot_direction: Object.freeze(['in', 'out'] as const),
  /**
   * 봇 송수신 결과(방향은 봇 관점, ADR-001 "수신(사람→Jarvis)"). out(봇 발신: 봇→서버 메시지 생성)은 사람 전송과 같은 sendAs 결과
   * (201 ok·200 멱등 재시도 duplicate·4xx rejected·그 밖 failed), in(봇 수신: 서버→봇 WS 전달)은 소켓 전달 ok·전달 중 예외 failed.
   * 두 방향의 실제 결과 집합의 합집합이다.
   */
  bot_outcome: Object.freeze(['ok', 'duplicate', 'rejected', 'failed'] as const),
  /** push 서비스 응답: 2xx sent, 404·410 expired(구독 삭제), 그 밖·연결 실패 failed(push/service.ts deliver). */
  push_outcome: Object.freeze(['sent', 'expired', 'failed'] as const),
});

/**
 * duration_ms 구간 하한(ms, 오름차순). 값은 자신이 속한 구간의 하한으로만 기록한다(PRD §10 "구간값만").
 * 경계는 NFR-05 p95 1초 목표·push 전송 타임아웃 10초를 가르도록 잡았다 — 세밀한 수치는 합성 테스트 결과로만 남긴다.
 */
export const DURATION_BUCKETS_MS = Object.freeze([0, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const);

/** ms → 구간 하한. 음수·비유한 값은 undefined(기록하지 않음). */
export function bucketDurationMs(ms: number): number | undefined {
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  let lower: number = DURATION_BUCKETS_MS[0];
  for (const edge of DURATION_BUCKETS_MS) if (ms >= edge) lower = edge;
  return lower;
}

const oneOf = <K extends keyof typeof METRIC_ENUMS>(key: K) => z.enum(METRIC_ENUMS[key]);
/** bucket·count: 0 이상 정수(구간 하한). */
const bucket = z.number().int().nonnegative();
/** duration_ms: DURATION_BUCKETS_MS의 하한값만(원시 ms 거부). */
const durationBucket = bucket.refine((v) => (DURATION_BUCKETS_MS as readonly number[]).includes(v));

const metric = <E extends MetricEvent, S extends z.ZodRawShape>(event: E, shape: S) =>
  z.strictObject({ event: z.literal(event), ...shape });

export const metricRecordSchema = z.discriminatedUnion('event', [
  metric('message_send_result', { outcome: oneOf('send_outcome'), conv_kind: oneOf('conv_kind'), has_thread: z.boolean(), duration_ms: durationBucket }),
  metric('sync_result', { trigger: oneOf('sync_trigger'), outcome: oneOf('sync_outcome'), caught_up_count: bucket, duration_ms: durationBucket }),
  metric('read_sync_result', { outcome: oneOf('read_sync_outcome'), duration_ms: durationBucket }),
  metric('auth_denied', { action: oneOf('auth_action'), reason: oneOf('auth_reason'), count: bucket }),
  metric('client_state', { state: oneOf('client_state'), count: bucket }),
  metric('bot_delivery_result', { direction: oneOf('bot_direction'), outcome: oneOf('bot_outcome'), has_attachment: z.boolean(), duration_ms: durationBucket }),
  metric('push_send_result', { outcome: oneOf('push_outcome') }),
]);

export type MetricRecord = z.infer<typeof metricRecordSchema>;

/** 허용 목록 밖 이벤트·키·값이면 undefined(기록하지 않음). 입력은 변경하지 않는다. */
export function toMetricRecord(input: unknown): MetricRecord | undefined {
  const parsed = metricRecordSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}
