/**
 * 화면 데이터 주입 경계(W-10b). 운영 구현은 `createHttpDataSource`(HTTP + WS, W-10c).
 * 값 필드는 TRD §3 `GET /api/conversations` 항목 필드(unread_count·mention_count·unread_thread_count)와 대응한다.
 */
import type { PendingMessage } from '../features/conversation';

export type SpaceKind = 'channel' | 'dm';

export interface Space {
  readonly id: string;
  readonly kind: SpaceKind;
  readonly name: string;
  readonly unreadCount: number;
  readonly mentionCount: number;
  readonly unreadThreadCount: number;
}

export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly rootId?: string;
  readonly author: string;
  readonly createdAt: string;
  readonly body: string;
  readonly replyCount: number;
  /** 내 전송 대기 항목(전송 중·저장 여부 확인 중·실패). 저장 확인이면 없음. */
  readonly pending?: PendingMessage;
  /** 서버 메시지 필드(HTTP 구현만 채운다). */
  readonly seq?: number;
  readonly authorId?: string;
  readonly clientMessageId?: string;
  readonly deleted?: boolean;
}

/** 디자인 §6-4 연결 상태 4종. */
export type ConnectionState = 'connected' | 'reconnecting' | 'offline' | 'catching-up';

export interface Snapshot {
  readonly spaces: readonly Space[];
  readonly messages: readonly Message[];
  readonly connection: ConnectionState;
}

export interface DataSource {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  send(target: { readonly conversationId: string; readonly rootId?: string }, body: string): void;
  /** 현재 대화가 바뀔 때 호출(구독·이력 로드). 메모리 구현은 없음. */
  open?(conversationId: string | null): void;
}

export interface MemoryDataSource extends DataSource {
  setConnection(state: ConnectionState): void;
}

/** 메모리 구현(테스트·개발용). 스냅숏은 매 변경마다 새 객체로 교체한다(불변). */
export function createMemoryDataSource(seed: Snapshot): MemoryDataSource {
  let snapshot: Snapshot = Object.freeze({ ...seed });
  let nextId = 0;
  const listeners = new Set<() => void>();
  const replace = (next: Snapshot) => {
    snapshot = Object.freeze(next);
    listeners.forEach((l) => l());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(target, body) {
      nextId += 1;
      const message: Message = {
        id: `local-${nextId}`,
        conversationId: target.conversationId,
        ...(target.rootId === undefined ? {} : { rootId: target.rootId }),
        author: '나',
        createdAt: new Date().toISOString(),
        body,
        replyCount: 0,
      };
      const messages = snapshot.messages.map((m) =>
        m.id === target.rootId ? { ...m, replyCount: m.replyCount + 1 } : m,
      );
      replace({ ...snapshot, messages: [...messages, message] });
    },
    setConnection(connection) {
      replace({ ...snapshot, connection });
    },
  };
}
