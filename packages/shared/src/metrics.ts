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
});

const oneOf = <K extends keyof typeof METRIC_ENUMS>(key: K) => z.enum(METRIC_ENUMS[key]);
/** bucket·count: 0 이상 정수(구간 하한). */
const bucket = z.number().int().nonnegative();

const metric = <E extends MetricEvent, S extends z.ZodRawShape>(event: E, shape: S) =>
  z.strictObject({ event: z.literal(event), ...shape });

export const metricRecordSchema = z.discriminatedUnion('event', [
  metric('message_send_result', { outcome: oneOf('send_outcome'), conv_kind: oneOf('conv_kind'), has_thread: z.boolean(), duration_ms: bucket }),
  metric('sync_result', { trigger: oneOf('sync_trigger'), outcome: oneOf('sync_outcome'), caught_up_count: bucket, duration_ms: bucket }),
  metric('read_sync_result', { outcome: oneOf('read_sync_outcome'), duration_ms: bucket }),
  metric('auth_denied', { action: oneOf('auth_action'), reason: oneOf('auth_reason'), count: bucket }),
  metric('client_state', { state: oneOf('client_state'), count: bucket }),
]);

export type MetricRecord = z.infer<typeof metricRecordSchema>;

/** 허용 목록 밖 이벤트·키·값이면 undefined(기록하지 않음). 입력은 변경하지 않는다. */
export function toMetricRecord(input: unknown): MetricRecord | undefined {
  const parsed = metricRecordSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}
