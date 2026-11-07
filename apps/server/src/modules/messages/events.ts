import type { MessageRecord } from './store.js';

/**
 * 메시지 도메인 이벤트(B3). 서비스가 DB **커밋 후**에만 발행한다. W-09 realtime이 구독해 WS로 팬아웃한다.
 * deleted 이벤트는 본문·mention을 싣지 않는다(TRD §4 `message.deleted`).
 */
export interface MessageChange {
  readonly changeId: number;
  readonly message: MessageRecord;
}

export interface MessageDeleted {
  readonly changeId: number;
  readonly conversationId: string;
  readonly messageId: string;
  readonly seq: number;
  readonly deletedAt: Date;
}

export interface MessageEventMap {
  created: MessageChange;
  updated: MessageChange;
  deleted: MessageDeleted;
}

export type MessageEventName = keyof MessageEventMap;

export interface MessageEvents {
  created(event: MessageChange): void;
  updated(event: MessageChange): void;
  deleted(event: MessageDeleted): void;
  on<K extends MessageEventName>(name: K, listener: (event: MessageEventMap[K]) => void): () => void;
}

export function createMessageEvents(): MessageEvents {
  const listeners: { [K in MessageEventName]: Set<(event: MessageEventMap[K]) => void> } = {
    created: new Set(),
    updated: new Set(),
    deleted: new Set(),
  };
  const emit = <K extends MessageEventName>(name: K, event: MessageEventMap[K]): void => {
    for (const listener of listeners[name]) listener(event);
  };
  return {
    created: (event) => emit('created', event),
    updated: (event) => emit('updated', event),
    deleted: (event) => emit('deleted', event),
    on(name, listener) {
      listeners[name].add(listener);
      return () => listeners[name].delete(listener);
    },
  };
}
