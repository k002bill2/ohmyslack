import { useRef } from 'react';
import { THREAD_SUMMARY_COPY } from '../../ui/copy.js';

export interface ThreadSummaryProps {
  readonly rootId: string;
  readonly count: number;
  /** 이 스레드가 `unread_threads[]` 대상이고 새 답글이 남았나. */
  readonly unread: boolean;
  /** catch-up 중이면 새 답글 표시 갱신을 보류한다(UI_STATES §2-7). */
  readonly holding: boolean;
  readonly onOpen: (rootId: string) => void;
}

/**
 * CMP-14 ThreadSummary(UI_STATES §2-7): 답글 0 → 숨김, ≥1 → 「답글 n」, 새 답글 → 점 + 「새 답글」.
 * 「마지막 답글 n분 전」은 계약에 마지막 답글 시각이 없어 숫자만 렌더한다(W-10i REPORT).
 */
export function ThreadSummary({ rootId, count, unread, holding, onOpen }: ThreadSummaryProps) {
  const shown = useRef(unread);
  if (!holding) shown.current = unread;
  if (count < 1) return null;
  return (
    <button type="button" className="thread-summary" data-thread-summary-for={rootId} onClick={() => onOpen(rootId)}>
      {THREAD_SUMMARY_COPY.replies(count)}
      {shown.current && (
        <>
          {' '}
          <span className="thread-summary-dot" aria-hidden="true" />
          <span className="thread-summary-new">{THREAD_SUMMARY_COPY.newReplies}</span>
        </>
      )}
    </button>
  );
}
