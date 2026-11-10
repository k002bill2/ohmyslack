import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ActionFailure, ActionResult } from '../../data';
import { CANCEL_LABEL, LEAVE_CHANNEL_COPY, LEFT_CHANNEL_COPY } from '../../ui/copy.js';
import { Dialog } from '../../ui/Dialog.js';
import { ErrorState } from '../../ui/ErrorState.js';
import { failureText } from '../spaces';

export interface LeaveChannelControlProps {
  /** `DELETE …/membership`. 성공하면 Dialog를 닫는다(목록·구독은 DataSource가 정리). */
  readonly onLeave: () => Promise<ActionResult<null>>;
  /** 기본 「채널 나가기」 버튼 대신 그릴 진입점(R4 헤더 더보기 메뉴). 받은 `open`을 부르면 확인 Dialog가 열린다. */
  readonly renderTrigger?: (open: () => void) => ReactNode;
}

/**
 * ConversationHeader 「채널 나가기」(채널만, UI_STATES §2-5) → CMP-18 확인 Dialog(§2-8, `LEAVE_CHANNEL_COPY`).
 * Dialog는 `body`로 포털해 앱 전체를 inert로 만든다(멤버 관리 Dialog와 같은 규칙).
 */
export function LeaveChannelControl({ onLeave, renderTrigger }: LeaveChannelControlProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const attempt = useRef(0);

  const close = () => {
    attempt.current += 1;
    setOpen(false);
    setBusy(false);
    setFailure(null);
  };
  const confirm = async () => {
    const mine = ++attempt.current;
    setBusy(true);
    setFailure(null);
    const res = await onLeave();
    if (mine !== attempt.current) return;
    setBusy(false);
    if (res.ok) setOpen(false);
    else setFailure(res);
  };

  return (
    <>
      {renderTrigger === undefined ? (
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
          {LEFT_CHANNEL_COPY.leave}
        </button>
      ) : (
        renderTrigger(() => setOpen(true))
      )}
      {open &&
        createPortal(
          <Dialog title={LEAVE_CHANNEL_COPY.title} onClose={close}>
            <div className="dialog-form">
              <p>{LEAVE_CHANNEL_COPY.body}</p>
              {failure !== null && <ErrorState message={failureText(failure)} />}
              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={close}>
                  {CANCEL_LABEL}
                </button>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void confirm()}>
                  {LEAVE_CHANNEL_COPY.confirm}
                </button>
              </div>
            </div>
          </Dialog>,
          document.body,
        )}
    </>
  );
}

/** ConversationHeader 「나간 채널」 행: 「다시 참여」만(UI_STATES §2-5). */
export function RejoinButton({ onRejoin }: { readonly onRejoin: () => void }) {
  return (
    <button type="button" className="btn btn-secondary" onClick={onRejoin}>
      {LEFT_CHANNEL_COPY.rejoin}
    </button>
  );
}

/** MessageList 「나간 채널」 행: 안내 + 「참여」, 작성기는 호출자가 숨긴다(UI_STATES §2-5·§2-6). */
export function LeftChannelNotice({ onRejoin }: { readonly onRejoin: () => void }) {
  return (
    <div className="left-channel-notice">
      <p>{LEFT_CHANNEL_COPY.notice}</p>
      <button type="button" className="btn btn-primary" onClick={onRejoin}>
        {LEFT_CHANNEL_COPY.join}
      </button>
    </div>
  );
}
