import { z } from 'zod';

/**
 * Web Push 계약(정본: TRD §6-2, §2 `push_subscriptions`, §3 push 라우트, DEV_DESIGN TR-SEC-15).
 * 서버·웹·테스트는 이 상수를 읽는다(정본 수치 복제 금지).
 */

/** push service 응답 보관 시간(초). TRD §6-2 「TTL 헤더 필수(제안 86400)」. */
export const PUSH_TTL_SECONDS = 86_400;
/** 같은 대화 알림 묶음 창(밀리초). 창 안의 두 번째 이후 알림은 같은 `Topic`으로 교체되고 서버에서도 1건으로 줄인다. */
export const PUSH_COALESCE_WINDOW_MS = 60_000;

/** 정확히 일치해야 하는 endpoint 호스트. */
export const PUSH_ENDPOINT_EXACT_HOSTS = Object.freeze(['fcm.googleapis.com', 'updates.push.services.mozilla.com'] as const);
/** 접미사로 허용하는 endpoint 호스트(`*.push.apple.com`). 접미사 자체(`push.apple.com`)는 허용하지 않는다. */
export const PUSH_ENDPOINT_HOST_SUFFIXES = Object.freeze(['.push.apple.com'] as const);

/**
 * endpoint 허용 판정: https 스킴 + 기본 포트 + 사용자 정보 없음 + 허용목록 호스트.
 * 파싱 실패·다른 스킴·허용목록 밖이면 false. 입력은 변경하지 않는다.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  if ((PUSH_ENDPOINT_EXACT_HOSTS as readonly string[]).includes(host)) return true;
  return PUSH_ENDPOINT_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

/** endpoint 최대 길이(바이트 아님, 문자). 브라우저 endpoint는 수백 자 수준이다. */
export const PUSH_ENDPOINT_MAX_LENGTH = 2048;
const base64url = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+={0,2}$/);

/** `GET /api/push/vapid-public-key` 200 응답. push 비활성이면 404(본문은 공통 오류). */
export const vapidPublicKeyResponseSchema = z.strictObject({
  public_key: base64url,
});
export type VapidPublicKeyResponse = z.infer<typeof vapidPublicKeyResponseSchema>;

/** `POST /api/push/subscriptions` 요청 본문 = `PushSubscription.toJSON()`의 endpoint·keys(expirationTime은 무시). */
export const pushSubscriptionCreateSchema = z.object({
  endpoint: z.string().min(1).max(PUSH_ENDPOINT_MAX_LENGTH),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: base64url, auth: base64url }),
});
export type PushSubscriptionCreate = z.infer<typeof pushSubscriptionCreateSchema>;

/** `POST /api/push/subscriptions` 201 응답. 해제 시 이 id로 `DELETE /api/push/subscriptions/{id}`. */
export const pushSubscriptionCreatedSchema = z.strictObject({
  subscription: z.strictObject({ id: z.uuid() }),
});
export type PushSubscriptionCreated = z.infer<typeof pushSubscriptionCreatedSchema>;

/**
 * push payload(TR-SEC-15): 식별자만, 본문·대화 이름·작성자 이름 없음. strict — 허용 키 밖 필드는 파싱 실패.
 * `thread_root_id`는 스레드 답글일 때만 있다.
 */
export const pushPayloadSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('message'),
  conversation_id: z.uuid(),
  message_id: z.uuid(),
  thread_root_id: z.uuid().optional(),
  from_bot: z.boolean(),
});
export type PushPayload = z.infer<typeof pushPayloadSchema>;
/** payload 허용 키(테스트가 이 집합 밖 키 0건을 확인한다). */
export const PUSH_PAYLOAD_KEYS = Object.freeze(['v', 'kind', 'conversation_id', 'message_id', 'thread_root_id', 'from_bot'] as const);
