/**
 * 메시지 전송 상태 전이(UI_STATES §2-5 전이 1–6, 디자인 §6-3). 순수 리듀서 — 대기 항목은 화면 메모리에만 둔다.
 * 저장 판정은 HTTP 결과로 한다. 연결 단절만으로 미저장을 단정하지 않고, 자동 재전송 큐를 만들지 않는다.
 */

export type SendStatus = 'sending' | 'confirmed' | 'unknown' | 'failed';

/** 실패 종류: 다시 시도 가능 / 400(상한·빈 본문)·409 → 「다시 작성」(새 client_message_id). */
export type FailureKind = 'retryable' | 'rewrite';

export interface PendingMessage {
  readonly conversationId: string;
  readonly authorId: string;
  readonly clientMessageId: string;
  readonly body: string;
  readonly status: SendStatus;
  readonly failure?: FailureKind | undefined;
  /** 「전송 중」에 대응 키가 같은 `message.created`를 받았다는 표식(전이 6). */
  readonly serverEventSeen: boolean;
  readonly messageId?: string;
}

/** 대응 키(UI_STATES §2-5): (conversation_id, author_id = 나, client_message_id). */
export interface MatchKey {
  readonly conversationId: string;
  readonly authorId: string;
  readonly clientMessageId: string;
}

export type SendEvent =
  | { readonly type: 'http-success'; readonly messageId: string }
  | { readonly type: 'http-error'; readonly status: number }
  | { readonly type: 'network-error' }
  | { readonly type: 'message-created'; readonly key: MatchKey; readonly messageId: string }
  | { readonly type: 'retry' }
  /** 다시 시도 시점에 `navigator.onLine === false` → HTTP 미호출, 즉시 실패(디자인 §6-1 오프라인). */
  | { readonly type: 'offline-retry' }
  | { readonly type: 'ws-closed' };

export function createPending(input: MatchKey & { readonly body: string; readonly online: boolean }): PendingMessage {
  const { online, ...rest } = input;
  return online
    ? { ...rest, status: 'sending', serverEventSeen: false }
    : { ...rest, status: 'failed', failure: 'retryable', serverEventSeen: false };
}

export function sameKey(item: PendingMessage, key: MatchKey): boolean {
  return (
    item.conversationId === key.conversationId &&
    item.authorId === key.authorId &&
    item.clientMessageId === key.clientMessageId
  );
}

function failureFor(status: number): FailureKind {
  return status === 400 || status === 409 ? 'rewrite' : 'retryable';
}

function onMessageCreated(item: PendingMessage, key: MatchKey, messageId: string): PendingMessage {
  if (!sameKey(item, key)) return item;
  if (item.status === 'unknown') return { ...item, status: 'confirmed', messageId };
  // 전이 6 + Jarvis 결정 4: 전송 중에는 표식만 남기고 HTTP 응답을 기다린다(Q-3 결정 전 기본값).
  if (item.status === 'sending') return { ...item, serverEventSeen: true, messageId };
  return item;
}

export function transition(item: PendingMessage, event: SendEvent): PendingMessage {
  switch (event.type) {
    case 'http-success':
      return item.status === 'sending'
        ? { ...item, status: 'confirmed', failure: undefined, messageId: event.messageId }
        : item;
    case 'http-error':
      return item.status === 'sending' ? { ...item, status: 'failed', failure: failureFor(event.status) } : item;
    case 'network-error':
      if (item.status !== 'sending') return item;
      return item.serverEventSeen ? { ...item, status: 'confirmed' } : { ...item, status: 'unknown' };
    case 'message-created':
      return onMessageCreated(item, event.key, event.messageId);
    case 'retry':
      return canRetry(item) ? { ...item, status: 'sending', failure: undefined } : item;
    case 'offline-retry':
      return canRetry(item) ? { ...item, status: 'failed', failure: 'retryable' } : item;
    case 'ws-closed':
      // 전이 1: 연결 단절·WS 종료는 어떤 상태도 바꾸지 않는다.
      return item;
  }
}

export function canRetry(item: PendingMessage): boolean {
  return item.status === 'unknown' || (item.status === 'failed' && item.failure === 'retryable');
}
