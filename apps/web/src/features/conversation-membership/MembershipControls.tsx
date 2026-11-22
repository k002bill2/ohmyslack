import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { settleAction, type ActionFailure, type ActionResult } from '../../data';
import { CANCEL_LABEL, LEAVE_CHANNEL_COPY, LEFT_CHANNEL_COPY } from '../../ui/copy.js';
import { Dialog } from '../../ui/Dialog.js';
import { ErrorState } from '../../ui/ErrorState.js';
import { failureText } from '../spaces';

export interface ConfirmChannelCopy {
  readonly title: string;
  readonly body: string;
  readonly confirm: string;
}

export interface ConfirmChannelControlProps {
  readonly copy: ConfirmChannelCopy;
  /** 확인 시 부르는 동작. 성공하면 Dialog를 닫는다(목록·구독은 DataSource가 정리). */
  readonly onConfirm: () => Promise<ActionResult<null>>;
  /** 진입점(헤더 더보기 메뉴 등). 없으면 기본 버튼(`fallbackLabel`). 받은 `open`을 부르면 확인 Dialog가 열린다. */
  readonly renderTrigger?: (open: () => void) => ReactNode;
  readonly fallbackLabel?: string;
}

/**
 * CMP-18 위험 동작 확인 Dialog(채널 나가기 §2-8·채널 삭제 FR-CONV-06 공용): 진행 중 확인 비활성·중복 요청 0,
 * 실패는 Dialog 안 ErrorState로 표시하고 Dialog를 유지한다. `body`로 포털해 앱 전체를 inert로 만든다.
 */
export function ConfirmChannelControl({ copy, onConfirm, renderTrigger, fallbackLabel }: ConfirmChannelControlProps) {
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
    if (busy) return;
    const mine = ++attempt.current;
    setBusy(true);
    setFailure(null);
    const res = await settleAction(onConfirm);
    if (mine !== attempt.current) return;
    setBusy(false);
    if (res.ok) setOpen(false);
    else setFailure(res);
  };

  return (
    <>
      {renderTrigger === undefined ? (
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
          {fallbackLabel ?? copy.title}
        </button>
      ) : (
        renderTrigger(() => setOpen(true))
      )}
      {open &&
        createPortal(
          <Dialog title={copy.title} onClose={close} busy={busy}>
            <div className="dialog-form">
              <p>{copy.body}</p>
              {failure !== null && <ErrorState message={failureText(failure)} />}
              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={close}>
                  {CANCEL_LABEL}
                </button>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void confirm()}>
                  {copy.confirm}
                </button>
              </div>
            </div>
          </Dialog>,
          document.body,
        )}
    </>
  );
}

export interface LeaveChannelControlProps {
  /** `DELETE …/membership`. 성공하면 Dialog를 닫는다(목록·구독은 DataSource가 정리). */
  readonly onLeave: () => Promise<ActionResult<null>>;
  /** 기본 「채널 나가기」 버튼 대신 그릴 진입점(R4 헤더 더보기 메뉴). 받은 `open`을 부르면 확인 Dialog가 열린다. */
  readonly renderTrigger?: (open: () => void) => ReactNode;
}

/** ConversationHeader 「채널 나가기」(채널만, UI_STATES §2-5) → CMP-18 확인 Dialog(§2-8, `LEAVE_CHANNEL_COPY`). */
export function LeaveChannelControl({ onLeave, renderTrigger }: LeaveChannelControlProps) {
  return (
    <ConfirmChannelControl
      copy={LEAVE_CHANNEL_COPY}
      onConfirm={onLeave}
      fallbackLabel={LEFT_CHANNEL_COPY.leave}
      {...(renderTrigger === undefined ? {} : { renderTrigger })}
    />
  );
}

/** ConversationHeader 「나간 채널」 행: 「다시 참여」만(UI_STATES §2-5). `data-rejoin`은 나간 직후 포커스 대상(focus-after-leave). */
export function RejoinButton({ onRejoin }: { readonly onRejoin: () => void }) {
  return (
    <button type="button" className="btn btn-secondary" data-rejoin="header" onClick={onRejoin}>
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
