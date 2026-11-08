/**
 * 봇 연결 닫기 훅(정본: TRD §5-2 2항 — 폐기·비활성화 시 열린 봇 WS 5초 내 close).
 * 이번 레인은 발행 자리만 둔다. 서비스는 COMMIT 뒤에만 발행하며 다음 레인이 봇 WS에 연결한다.
 */
export interface BotConnectionsCloseEvent {
  readonly botUserId: string;
  readonly tokenIds: readonly string[];
}

export type BotConnectionsCloseListener = (event: BotConnectionsCloseEvent) => void;

export interface BotEvents {
  onConnectionsClose(listener: BotConnectionsCloseListener): () => void;
  connectionsClose(event: BotConnectionsCloseEvent): void;
}

export function createBotEvents(): BotEvents {
  const listeners = new Set<BotConnectionsCloseListener>();
  return {
    onConnectionsClose(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connectionsClose(event) {
      const frozen = Object.freeze({ botUserId: event.botUserId, tokenIds: Object.freeze([...event.tokenIds]) });
      for (const listener of listeners) listener(frozen);
    },
  };
}
