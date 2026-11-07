/**
 * 세션 폐기 도메인 이벤트. 로그아웃·(W-06b)비활성화·만료 시 발행하고 realtime(W-09)이 구독해
 * 해당 WS를 5초 안에 닫는다(TRD §5, §5-1 S7). 이번 레인은 발행 자리만 둔다.
 */
export type SessionRevokedListener = (sessionIds: readonly string[]) => void;

export interface AuthEvents {
  onSessionRevoked(listener: SessionRevokedListener): () => void;
  sessionRevoked(sessionIds: readonly string[]): void;
}

export function createAuthEvents(): AuthEvents {
  const listeners = new Set<SessionRevokedListener>();
  return {
    onSessionRevoked(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sessionRevoked(sessionIds) {
      const ids = Object.freeze([...sessionIds]);
      for (const listener of listeners) listener(ids);
    },
  };
}
