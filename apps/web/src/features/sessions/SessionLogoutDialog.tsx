import type { ActionFailure } from '../../data';
import { CANCEL_LABEL, ERROR_COPY, SESSION_LIST_COPY } from '../../ui/copy.js';
import { Dialog } from '../../ui/Dialog.js';
import { failureText } from '../spaces';

export interface SessionLogoutDialogProps {
  readonly label: string;
  readonly busy: boolean;
  readonly failure: ActionFailure | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** 404(대상 없음) 「목록 새로 고침」. */
  readonly onRefresh: () => void;
}

/** CMP-18 기기 로그아웃 확인(G-69·G-70, UI_STATES §2-14). busy 규칙은 Dialog 공통(PR #31). */
export function SessionLogoutDialog({ label, busy, failure, onConfirm, onCancel, onRefresh }: SessionLogoutDialogProps) {
  const notFound = failure !== null && failure.status === 404;
  return (
    <Dialog title={SESSION_LIST_COPY.confirmTitle} onClose={onCancel} busy={busy}>
      <div className="dialog-form">
        <p>{SESSION_LIST_COPY.confirmBody(label)}</p>
        {failure !== null && (
          <div className="error-state" role="alert">
            <p>{`${SESSION_LIST_COPY.failed} ${failureText(failure)}`}</p>
            {notFound && (
              <button type="button" className="btn btn-secondary" onClick={onRefresh}>
                {ERROR_COPY.refreshList}
              </button>
            )}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>
            {CANCEL_LABEL}
          </button>
          {!notFound && (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={onConfirm}>
              {SESSION_LIST_COPY.confirm}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
