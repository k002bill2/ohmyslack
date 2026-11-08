/**
 * Web Push 서비스 워커 처리(순수 함수 + 주입 핸들러). 정본: TRD §6-2, UI_STATES §2-10 CMP-30.
 * payload는 식별자만 담는다(TR-SEC-15). 표시 문구는 고정이며 payload·본문을 어디에도 저장하지 않는다.
 * iOS는 silent push 금지 — payload가 없거나 잘못돼도 일반 알림을 반드시 띄운다.
 */
import type { PushPayload } from '../../../../../packages/shared/src/push.js';

/*
 * `sw.js`는 import 없는 단일 classic script여야 한다(vite.config.ts `swPlugin`). 앱 본체와 공유하는 모듈
 * (zod·`ui/copy.ts`·`app/route.ts`)을 값으로 import하면 공유 청크로 갈라져 빌드가 실패한다 — 그래서 이 모듈은
 * 타입만 import하고, 문구·검증·URL을 자체로 둔다. 일치는 테스트가 확인한다
 * (`PUSH_NOTIFICATION_COPY`(copy.ts)·`pushPayloadSchema`(shared)·`withThread`(route.ts)).
 */

/** 고정 문구 — `ui/copy.ts` `PUSH_NOTIFICATION_COPY`와 같아야 한다(테스트로 확인). */
export const SW_PUSH_COPY = Object.freeze({
  title: 'ohmyslack',
  botTitle: 'Jarvis',
  body: '새 메시지가 있습니다',
} as const);

const PAYLOAD_KEYS: ReadonlySet<string> = new Set(['v', 'kind', 'conversation_id', 'message_id', 'thread_root_id', 'from_bot']);
/** zod `z.uuid()`와 같은 형식(RFC 9562 버전 1–8 + nil·max). */
const UUID = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** `pushPayloadSchema`(strict)와 같은 판정. 허용 키 밖 필드·형식 이상이면 null. */
export function toPushPayload(raw: unknown): PushPayload | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !PAYLOAD_KEYS.has(k))) return null;
  if (o.v !== 1 || o.kind !== 'message' || !isUuid(o.conversation_id) || !isUuid(o.message_id) || typeof o.from_bot !== 'boolean') return null;
  if (o.thread_root_id !== undefined && !isUuid(o.thread_root_id)) return null;
  return {
    v: 1,
    kind: 'message',
    conversation_id: o.conversation_id,
    message_id: o.message_id,
    ...(o.thread_root_id === undefined ? {} : { thread_root_id: o.thread_root_id }),
    from_bot: o.from_bot,
  };
}

/** payload를 읽지 못했을 때의 알림 tag(같은 tag끼리 교체). */
export const GENERIC_PUSH_TAG = 'ohmyslack';

export interface NotificationSpec {
  readonly title: string;
  readonly options: {
    readonly body: string;
    readonly tag: string;
    readonly data: { readonly url: string };
  };
}

/** push 이벤트 데이터 → 검증된 payload. 없음·JSON 아님·계약 밖이면 null. */
export function parsePushData(data: { json(): unknown } | null | undefined): PushPayload | null {
  if (data === null || data === undefined) return null;
  let raw: unknown;
  try {
    raw = data.json();
  } catch {
    return null;
  }
  return toPushPayload(raw);
}

/** 알림 탭 대상: `/c/{conversation_id}`(+ `?thread={root}`) + `#message-{message_id}`. payload 없으면 `/`. */
export function pushTargetUrl(payload: PushPayload | null): string {
  if (payload === null) return '/';
  const base = `/c/${encodeURIComponent(payload.conversation_id)}`;
  // route.ts `withThread`와 같은 형식(`?thread=`).
  const path = payload.thread_root_id === undefined ? base : `${base}?${new URLSearchParams({ thread: payload.thread_root_id }).toString()}`;
  return `${path}#message-${encodeURIComponent(payload.message_id)}`;
}

/** 고정 제목·본문(Q-H5 ★). 본문·대화 이름·작성자 이름을 쓰지 않는다. */
export function notificationFor(payload: PushPayload | null): NotificationSpec {
  return {
    title: payload?.from_bot === true ? SW_PUSH_COPY.botTitle : SW_PUSH_COPY.title,
    options: {
      body: SW_PUSH_COPY.body,
      tag: payload?.conversation_id ?? GENERIC_PUSH_TAG,
      data: { url: pushTargetUrl(payload) },
    },
  };
}

export interface PushEventLike {
  readonly data?: { json(): unknown } | null;
  waitUntil(promise: Promise<unknown>): void;
}

export interface NotificationLike {
  readonly data?: unknown;
  close(): void;
}

export interface NotificationClickEventLike {
  readonly notification: NotificationLike;
  waitUntil(promise: Promise<unknown>): void;
}

export interface WindowClientLike {
  readonly url: string;
  focus(): Promise<unknown>;
  navigate?(url: string): Promise<unknown>;
}

export interface ClientsLike {
  matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WindowClientLike[]>;
  openWindow(url: string): Promise<unknown>;
}

export interface PushHandlerDeps {
  readonly showNotification: (title: string, options: NotificationSpec['options']) => Promise<void>;
  readonly clients: ClientsLike;
  readonly origin: string;
}

/** 알림 data의 url을 같은 출처 경로로만 받아들인다(다른 출처·형식 이상이면 `/`). */
function sameOriginPath(data: unknown, origin: string): string {
  const url = typeof data === 'object' && data !== null ? (data as { url?: unknown }).url : undefined;
  if (typeof url !== 'string') return '/';
  try {
    const parsed = new URL(url, origin);
    return parsed.origin === origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/';
  } catch {
    return '/';
  }
}

async function openOrFocus(clients: ClientsLike, origin: string, path: string): Promise<void> {
  const target = new URL(path, origin).href;
  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = windows.find((c) => {
    try {
      return new URL(c.url).origin === origin;
    } catch {
      return false;
    }
  });
  if (existing === undefined) {
    await clients.openWindow(target);
    return;
  }
  await existing.focus();
  if (existing.navigate !== undefined) await existing.navigate(target);
}

/** push·notificationclick 핸들러. 저장소 API는 받지 않는다(B7 — 알림 표시만). */
export function createPushHandlers(deps: PushHandlerDeps) {
  return {
    onPush(event: PushEventLike): void {
      const spec = notificationFor(parsePushData(event.data));
      event.waitUntil(deps.showNotification(spec.title, spec.options));
    },
    onNotificationClick(event: NotificationClickEventLike): void {
      event.notification.close();
      const path = sameOriginPath(event.notification.data, deps.origin);
      event.waitUntil(openOrFocus(deps.clients, deps.origin, path));
    },
  };
}
