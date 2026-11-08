import { sendNotification, WebPushError } from 'web-push';
import type { PushConfig } from './config.js';

/** 전송 대상 구독(web-push `PushSubscription` 형태). */
export interface PushSubscriptionTarget {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

export interface PushSendOptions {
  readonly TTL: number;
  /** 같은 대화 알림 교체용(≤32자 base64url). */
  readonly topic: string;
  readonly vapidDetails: { readonly subject: string; readonly publicKey: string; readonly privateKey: string };
}

/** push service 응답 상태 코드를 돌려준다. 연결 실패 등 응답이 없으면 throw. 주입 가능(테스트는 가짜 push service로 보낸다). */
export type PushSend = (target: PushSubscriptionTarget, payload: string, options: PushSendOptions) => Promise<number>;

const SEND_TIMEOUT_MS = 10_000;

/** 운영 전송: web-push `sendNotification`(RFC 8291 aes128gcm + RFC 8292 VAPID). 2xx 밖 응답은 WebPushError의 상태 코드로 바꾼다. */
export const webPushSend: PushSend = async (target, payload, options) => {
  try {
    const res = await sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.keys.p256dh, auth: target.keys.auth } },
      payload,
      { TTL: options.TTL, topic: options.topic, vapidDetails: { ...options.vapidDetails }, timeout: SEND_TIMEOUT_MS },
    );
    return res.statusCode;
  } catch (error) {
    if (error instanceof WebPushError) return error.statusCode;
    throw error;
  }
};

export function vapidDetailsOf(config: PushConfig): PushSendOptions['vapidDetails'] {
  return { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey };
}

/** 같은 대화 알림의 `Topic`: 대화 UUID의 하이픈을 뗀 32자(hex ⊂ base64url). */
export function topicOf(conversationId: string): string {
  return conversationId.replaceAll('-', '');
}
