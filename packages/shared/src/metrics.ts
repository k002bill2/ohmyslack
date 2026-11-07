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

/** enum 값: 사전 정의 소문자 토큰만(임의 문자열·본문 차단). */
const token = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
/** bucket·count: 0 이상 정수(구간 하한). */
const bucket = z.number().int().nonnegative();

const metric = <E extends MetricEvent, S extends z.ZodRawShape>(event: E, shape: S) =>
  z.strictObject({ event: z.literal(event), ...shape });

export const metricRecordSchema = z.discriminatedUnion('event', [
  metric('message_send_result', { outcome: token, conv_kind: token, has_thread: z.boolean(), duration_ms: bucket }),
  metric('sync_result', { trigger: token, outcome: token, caught_up_count: bucket, duration_ms: bucket }),
  metric('read_sync_result', { outcome: token, duration_ms: bucket }),
  metric('auth_denied', { action: token, reason: token, count: bucket }),
  metric('client_state', { state: token, count: bucket }),
]);

export type MetricRecord = z.infer<typeof metricRecordSchema>;

/** 허용 목록 밖 이벤트·키·값이면 undefined(기록하지 않음). 입력은 변경하지 않는다. */
export function toMetricRecord(input: unknown): MetricRecord | undefined {
  const parsed = metricRecordSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}
