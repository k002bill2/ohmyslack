import type { ActionFailure } from '../../data';
import { CANCEL_LABEL, DIALOG_TITLES, MEMBER_ADMIN_COPY, MEMBER_DEACTIVATE_COPY } from '../../ui/copy.js';
import { Dialog } from '../../ui/Dialog.js';
import { ErrorState } from '../../ui/ErrorState.js';
import { failureText } from '../spaces';

export interface DeactivateDialogProps {
  readonly busy: boolean;
  readonly failure: ActionFailure | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** CMP-18 멤버 비활성화 확인(UI_STATES §2-8): 정본 본문 + 「취소」·「멤버 비활성화」, 오류 → ErrorState. */
export function DeactivateDialog({ busy, failure, onConfirm, onCancel }: DeactivateDialogProps) {
  return (
    <Dialog title={DIALOG_TITLES.deactivateMember} onClose={onCancel}>
      <div className="dialog-form">
        <p>{MEMBER_ADMIN_COPY.deactivateBody}</p>
        {failure !== null && <ErrorState message={failureText(failure)} />}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            {CANCEL_LABEL}
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={onConfirm}>
            {MEMBER_DEACTIVATE_COPY.confirm}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
