import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { ActionResult } from '../../data/index.js';
import { Dialog } from '../../ui/Dialog.js';
import { ErrorState } from '../../ui/ErrorState.js';
import { CANCEL_LABEL, DELETE_MESSAGE_COPY } from '../../ui/copy.js';
import { failureView, type FailureView } from './MessageItemRules.js';

export interface DeleteMessageDialogProps {
  readonly onConfirm: () => Promise<ActionResult<null>>;
  readonly onClose: () => void;
  /** 2xx 뒤(자리표시자로 바뀐 뒤) 호출 — 포커스를 메시지 항목으로(UI_STATES §8 I-4). */
  readonly onDeleted: () => void;
}

/** CMP-18 메시지 삭제 확인 Dialog(G-24, UI_STATES §2-8). 403·404는 다시 시도 없이 안내만. */
export function DeleteMessageDialog({ onConfirm, onClose, onDeleted }: DeleteMessageDialogProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FailureView | null>(null);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await onConfirm();
    if (result.ok) {
      onDeleted();
      return;
    }
    setBusy(false);
    setFailure(failureView(result));
  };

  // 앱 전체를 inert로 — 메시지 목록 안에 렌더하면 형제만 막힌다(W-10h와 같은 portal).
  return createPortal(
    <Dialog title={DELETE_MESSAGE_COPY.title} onClose={onClose}>
      <p>{DELETE_MESSAGE_COPY.body}</p>
      {failure !== null && <ErrorState message={failure.text} {...(failure.retryable ? { onRetry: () => void confirm() } : {})} />}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {CANCEL_LABEL}
        </button>
        {(failure === null || failure.retryable) && (
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void confirm()}>
            {DELETE_MESSAGE_COPY.confirm}
          </button>
        )}
      </div>
    </Dialog>,
    document.body,
  );
}
