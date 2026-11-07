import { clearCheckpoints } from './checkpoint.js';

export type SessionEndReason = 'logout' | 'unauthorized' | 'account-switch';

export interface SessionBus {
  onEnd(listener: (reason: SessionEndReason) => void): () => void;
  end(reason: SessionEndReason): void;
}

/**
 * 세션 종료(로그아웃·401·계정 전환) 알림. checkpoint를 먼저 지우고(TRD S11) 구독자가 화면 메모리 상태를
 * 비운다(FR-CLIENT-04, 디자인 §6-4 "401 수신 시 모든 화면 데이터를 메모리에서 비움").
 */
export function createSessionBus(clear: () => void = clearCheckpoints): SessionBus {
  const listeners = new Set<(reason: SessionEndReason) => void>();
  return {
    onEnd(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    end(reason) {
      clear();
      listeners.forEach((l) => l(reason));
    },
  };
}
