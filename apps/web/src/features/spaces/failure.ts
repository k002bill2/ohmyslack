import type { ActionFailure } from '../../data';
import { ERROR_COPY, FORBIDDEN_TEXT } from '../../ui/copy.js';

/** 실패 → ErrorState 원인 1문장(G-19). 403은 「권한이 없습니다」(D §4-2). */
export function failureText(f: ActionFailure): string {
  if (f.status === 'network') return f.timedOut === true ? ERROR_COPY.timeout : ERROR_COPY.network;
  if (f.status === 403) return FORBIDDEN_TEXT;
  if (f.status === 404) return ERROR_COPY.notFound;
  if (f.status === 429) return ERROR_COPY.rateLimited;
  if (f.status >= 500) return ERROR_COPY.server;
  return ERROR_COPY.badRequest;
}

/** 단정 접두 + 원인 1문장. 시간 초과(결과 미확인)면 접두가 실패를 단정해 모순되므로 미확인 문장만(G-79). */
export function prefixedFailureText(prefix: string, unconfirmed: string, f: ActionFailure): string {
  if (f.status === 'network' && f.timedOut === true) return unconfirmed;
  return `${prefix} ${failureText(f)}`;
}

/** 다시 시도로 풀릴 수 있는 실패인가(네트워크·429·5xx). */
export function isRetryable(f: ActionFailure): boolean {
  return f.status === 'network' || f.status === 429 || f.status >= 500;
}
