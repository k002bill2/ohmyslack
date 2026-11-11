import { MESSAGE_STATUS_COPY as COPY, RETRY_LABEL } from '../../ui/copy.js';
import type { PendingMessage } from './send-status.js';

export interface MessageStatusProps {
  readonly item: PendingMessage;
  readonly onRetry: () => void;
  readonly onDiscard: () => void;
  /** false면 「전송 실패」에 「다시 시도」를 두지 않는다(G-52 잠긴 DM — 다시 보내도 403). 기본 true. 「확인 안 됨」은 재생 확인이라 그대로. */
  readonly failedRetry?: boolean;
}

/**
 * CMP-07 MessageItem의 전송 상태 표시(문구 정본: 디자인 §6-3, UI_STATES §4-4·§9 G-20·G-34·G-35). 아이콘은 Q-14 미정이라 텍스트만.
 * 「저장 확인」은 표시 없음. 라벨(muted)과 「다시 시도」 버튼을 따로 두고, 버튼 접근 이름은 정본 문구를 유지한다(G-35).
 */
export function MessageStatus({ item, onRetry, onDiscard, failedRetry = true }: MessageStatusProps) {
  switch (item.status) {
    case 'confirmed':
      return null;
    case 'sending':
      return (
        <span className="msg-status" aria-label="전송 중">
          전송 중
        </span>
      );
    case 'unknown':
      return (
        <div className="msg-status" role="status">
          <span className="msg-status-label">{COPY.unknownLabel}</span>
          <button type="button" className="msg-status-retry" aria-label={COPY.unknownRetryName} onClick={onRetry}>
            {RETRY_LABEL}
          </button>
          <button type="button" className="msg-status-discard" onClick={onDiscard}>
            {COPY.unknownDiscard}
          </button>
        </div>
      );
    case 'failed':
      return (
        <div className="msg-status msg-failed" role="alert">
          {item.failure === 'rewrite' ? (
            <span>{item.rewriteReason === 'conflict' ? COPY.rewriteConflict : COPY.rewriteInvalid}</span>
          ) : (
            <>
              <span className="msg-status-label">{COPY.failedLabel}</span>
              {failedRetry && (
                <button type="button" className="msg-status-retry" aria-label={COPY.failedRetryName} onClick={onRetry}>
                  {RETRY_LABEL}
                </button>
              )}
            </>
          )}
          <button type="button" className="msg-status-discard" onClick={onDiscard}>
            삭제
          </button>
        </div>
      );
  }
}
