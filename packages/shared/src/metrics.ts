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

/**
 * count·caught_up_count 구간 하한(오름차순, 마지막 값이 상한). 값은 자신이 속한 구간의 하한으로만 기록한다(PRD §10 "구간값만",
 * SEC R1: 무상한 정수는 사실상 원시값이라 dims 조합이 무한히 늘 수 있다). 1·2·5 배수 열로 잡아 "0건/1건/몇 건/수십/수백"을
 * 가르고, 1000 이상은 전부 1000(상한)으로 묶는다. 서버 auth_denied의 count:1은 그대로 유효하다.
 */
export const COUNT_BUCKETS = Object.freeze([0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000] as const);

/** 정수 개수 → 구간 하한(상한 이상은 상한). 음수·비정수·비유한 값은 undefined(기록하지 않음). */
export function bucketCount(n: number): number | undefined {
  if (!Number.isSafeInteger(n) || n < 0) return undefined;
  let lower: number = COUNT_BUCKETS[0];
  for (const edge of COUNT_BUCKETS) if (n >= edge) lower = edge;
  return lower;
}

/** ms → 구간 하한. 음수·비유한 값은 undefined(기록하지 않음). */
export function bucketDurationMs(ms: number): number | undefined {
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  let lower: number = DURATION_BUCKETS_MS[0];
  for (const edge of DURATION_BUCKETS_MS) if (ms >= edge) lower = edge;
  return lower;
}

const oneOf = <K extends keyof typeof METRIC_ENUMS>(key: K) => z.enum(METRIC_ENUMS[key]);
const nonNegativeInt = z.number().int().nonnegative();
/** count·caught_up_count: COUNT_BUCKETS의 하한값만(원시 개수·상한 초과 거부, R1). */
const bucket = nonNegativeInt.refine((v) => (COUNT_BUCKETS as readonly number[]).includes(v));
/** duration_ms: DURATION_BUCKETS_MS의 하한값만(원시 ms 거부). */
const durationBucket = nonNegativeInt.refine((v) => (DURATION_BUCKETS_MS as readonly number[]).includes(v));

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

/**
 * 클라이언트가 관찰해 보내는 이벤트(PRD §10 2단계, TRD 391행). 서버가 결과를 확정하는 4종(message_send_result·auth_denied·
 * bot_delivery_result·push_send_result)은 클라이언트가 보낼 수 없다 — 위조로 서버 집계를 오염시키지 못하게.
 */
export const CLIENT_METRIC_EVENTS = Object.freeze(['sync_result', 'read_sync_result', 'client_state'] as const);
export type ClientMetricEvent = (typeof CLIENT_METRIC_EVENTS)[number];

/**
 * 수집 배치 상한(POST /api/metrics). 클라이언트는 같은 (event, dims)를 메모리에서 합산해 60초마다 보내므로, 정상 배치는
 * 키 수(클라이언트 3종의 dims 조합 중 실제로 나타나는 것, 수십 개)만큼의 레코드다.
 * - records 32개: 한 주기에 나타나는 조합 수보다 넉넉하고, 본문 8KB 안에 들어간다(레코드 1개 ≈ 120바이트).
 * - n 1..100: 한 주기 한 조합의 정상 횟수(재연결·포그라운드 sync 몇 번)보다 크고, 오프라인 재합산분도 이 안에서 자른다.
 * - 본문 8KB: 위 둘의 곱보다 작게 — 큰 본문으로 파서·검증 비용을 키우지 못하게.
 */
export const CLIENT_METRIC_MAX_RECORDS = 32;
export const CLIENT_METRIC_MAX_N = 100;
export const CLIENT_METRIC_BODY_LIMIT_BYTES = 8 * 1024;

/** 레코드 1개의 모양(값 검증은 toClientMetric). dims 내용은 여기서 보지 않는다 — 위반 레코드는 개별로 버린다. */
const clientMetricShape = z.strictObject({
  event: z.enum(CLIENT_METRIC_EVENTS),
  dims: z.record(z.string(), z.unknown()),
  n: z.number().int().min(1).max(CLIENT_METRIC_MAX_N),
});

/**
 * 배치 본문 형식: records 배열(길이 상한)만 strict로 본다. 형식 자체가 깨지면(객체 아님·records 없음·길이 초과·여분 키) 400,
 * 레코드 개별 위반은 toClientMetric이 버린다(전체 거부 대신 — 클라이언트가 재전송 루프에 빠지지 않게).
 */
export const clientMetricBatchSchema = z.strictObject({
  records: z.array(z.unknown()).max(CLIENT_METRIC_MAX_RECORDS),
});
export type ClientMetricBatch = z.infer<typeof clientMetricBatchSchema>;

/** 전송용 레코드(웹이 만든다). dims는 event를 뺀 allowlist 필드. */
export interface ClientMetricWire {
  readonly event: ClientMetricEvent;
  readonly dims: Readonly<Record<string, string | number | boolean>>;
  readonly n: number;
}

/** 검증된 클라이언트 레코드: allowlist를 통과한 레코드와 증분. */
export interface ClientMetric {
  readonly record: MetricRecord;
  readonly n: number;
}

/**
 * 레코드 1개 검증: 클라이언트 3종(clientMetricShape의 event enum이 유일한 제한 지점)·n 범위·dims가 toMetricRecord allowlist(키·enum·구간값)를 통과해야 한다.
 * dims에 event 키가 있으면 거부한다(바깥 event를 덮어써 서버 이벤트를 위조하지 못하게). 위반은 undefined. 입력 불변.
 */
export function toClientMetric(input: unknown): ClientMetric | undefined {
  const shape = clientMetricShape.safeParse(input);
  if (!shape.success || 'event' in shape.data.dims) return undefined;
  const record = toMetricRecord({ ...shape.data.dims, event: shape.data.event });
  if (record === undefined) return undefined;
  return { record, n: shape.data.n };
}
