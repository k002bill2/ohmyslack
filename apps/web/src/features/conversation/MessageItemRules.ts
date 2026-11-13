/** CMP-07 메시지 액션 규칙(W-10i, 순수). 서버 403이 최종 판정이고 화면은 노출만 가린다. */
import type { ActionFailure } from '../../data/index.js';
import { ERROR_COPY } from '../../ui/copy.js';

export interface ActionTarget {
  readonly authorId?: string;
  readonly deleted?: boolean;
  readonly pending?: unknown;
}

/** 수정·삭제 노출: 본인 메시지 + 저장 확인(전송 대기 아님) + 삭제되지 않음(UI_STATES §2-5). */
export function canModify(message: ActionTarget, selfId: string | undefined): boolean {
  return selfId !== undefined && message.authorId === selfId && message.deleted !== true && message.pending === undefined;
}

export interface FailureView {
  readonly text: string;
  /** 다시 시도 가능한 오류인가(D §6-1: 네트워크·5xx·429만). */
  readonly retryable: boolean;
}

/** 수정·삭제 실패 → ErrorState 원인 1문장(G-19). 403·404는 재시도 불가 안내(UI_STATES §2-8). */
export function failureView(failure: ActionFailure): FailureView {
  const { status } = failure;
  if (status === 'network') return { text: failure.timedOut === true ? ERROR_COPY.timeout : ERROR_COPY.network, retryable: true };
  if (status === 403 || status === 404) return { text: ERROR_COPY.notFound, retryable: false };
  if (status === 429) return { text: ERROR_COPY.rateLimited, retryable: true };
  if (status >= 500) return { text: ERROR_COPY.server, retryable: true };
  return { text: ERROR_COPY.badRequest, retryable: false };
}
