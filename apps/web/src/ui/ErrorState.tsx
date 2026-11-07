import { RETRY_LABEL } from './copy.js';

export interface ErrorStateProps {
  /** 원인 1문장(D §6-1, G-19). */
  readonly message: string;
  /** 있으면 「다시 시도」 버튼을 둔다(다시 시도 가능한 오류만). */
  readonly onRetry?: () => void;
  readonly retryDisabled?: boolean;
}

/** CMP-17 ErrorState — 원인 1문장 + 행동 1개(D §6-1, UI_STATES §2-9). */
export function ErrorState({ message, onRetry, retryDisabled = false }: ErrorStateProps) {
  return (
    <div className="error-state" role="alert">
      <p>{message}</p>
      {onRetry !== undefined && (
        <button type="button" disabled={retryDisabled} onClick={onRetry}>
          {RETRY_LABEL}
        </button>
      )}
    </div>
  );
}
