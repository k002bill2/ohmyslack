import type { PendingMessage } from './send-status.js';

export interface MessageStatusProps {
  readonly item: PendingMessage;
  readonly onRetry: () => void;
  readonly onDiscard: () => void;
}

/**
 * CMP-07 MessageItem의 전송 상태 표시(문구 정본: 디자인 §6-3, UI_STATES §4-4). 아이콘은 Q-14 미정이라 텍스트만.
 * 「저장 확인」은 표시 없음. 「저장 여부 확인 중」 로컬 삭제 버튼은 문구 미정(Q-15)이라 렌더하지 않는다.
 */
export function MessageStatus({ item, onRetry, onDiscard }: MessageStatusProps) {
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
          <button type="button" onClick={onRetry}>
            저장 여부 확인 중 · 다시 시도
          </button>
        </div>
      );
    case 'failed':
      return (
        <div className="msg-status msg-failed" role="alert">
          {item.failure === 'rewrite' ? (
            <span>다시 작성</span>
          ) : (
            <button type="button" onClick={onRetry}>
              전송 실패 · 다시 시도
            </button>
          )}
          <button type="button" onClick={onDiscard}>
            삭제
          </button>
        </div>
      );
  }
}
