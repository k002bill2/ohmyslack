/**
 * 읽음 도메인 이벤트. 서비스가 DB **커밋 후**에만 발행한다. W-09b realtime이 구독해 같은 계정의 기기들에
 * WS `read.updated`(TRD §4)로 전달한다. `threadRootId === null`은 본문 읽음.
 */
export interface ReadUpdated {
  readonly userId: string;
  readonly conversationId: string;
  readonly threadRootId: string | null;
  readonly lastReadSeq: number;
  readonly updatedAt: Date;
}

export type ReadUpdatedListener = (event: ReadUpdated) => void;

export interface ReadEvents {
  updated(event: ReadUpdated): void;
  onUpdated(listener: ReadUpdatedListener): () => void;
}

export function createReadEvents(): ReadEvents {
  const listeners = new Set<ReadUpdatedListener>();
  return {
    updated(event) {
      for (const listener of listeners) listener(event);
    },
    onUpdated(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
