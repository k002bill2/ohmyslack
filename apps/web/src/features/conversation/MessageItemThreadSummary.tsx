import { useRef } from 'react';
import { THREAD_SUMMARY_COPY } from '../../ui/copy.js';

export interface ThreadSummaryProps {
  readonly rootId: string;
  readonly count: number;
  /** 이 스레드가 `unread_threads[]` 대상이고 새 답글이 남았나. */
  readonly unread: boolean;
  /** catch-up 중이면 새 답글 표시 갱신을 보류한다(UI_STATES §2-7). */
  readonly holding: boolean;
  /** 이 스레드가 지금 열려 있나(시안 01: 열린 스레드의 루트 칩 강조). 「새 답글」 표시와 별개다. */
  readonly active?: boolean;
  readonly onOpen: (rootId: string) => void;
}

/**
 * CMP-14 ThreadSummary(UI_STATES §2-7): 답글 0 → 숨김, ≥1 → 「답글 n」, 새 답글 → 점 + 「새 답글」.
 * 「마지막 답글 n분 전」은 계약에 마지막 답글 시각이 없어 숫자만 렌더한다(W-10i REPORT).
 */
export function ThreadSummary({ rootId, count, unread, holding, active = false, onOpen }: ThreadSummaryProps) {
  const shown = useRef(unread);
  if (!holding) shown.current = unread;
  if (count < 1) return null;
  return (
    <button
      type="button"
      className={active ? 'thread-summary thread-summary-active' : 'thread-summary'}
      data-thread-summary-for={rootId}
      {...(active ? { 'aria-current': 'true' as const } : {})}
      onClick={() => onOpen(rootId)}
    >
      {/* 시안 01·05 「↳」: 장식이라 접근 이름에서 뺀다(W-11d). */}
      <span className="thread-summary-icon" aria-hidden="true">
        ↳{' '}
      </span>
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
