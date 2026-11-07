import { useRef } from 'react';
import type { ActionFailure } from '../../data';
import { DIALOG_TITLES, MEMBER_ADMIN_COPY } from '../../ui/copy.js';
import { Dialog } from '../../ui/Dialog.js';
import { ErrorState } from '../../ui/ErrorState.js';
import { failureText, isRetryable } from '../spaces';
import { formatExpiry } from './format.js';

/** 초대 발급 상태. 링크는 이 상태(메모리)에만 있다 — 저장소·로그·주소에 쓰지 않는다. */
export type InviteView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly failure: ActionFailure }
  | { readonly kind: 'ready'; readonly link: string; readonly expiresAt: string };

export interface InviteDialogProps {
  readonly view: InviteView;
  readonly onRetry: () => void;
  /** 닫기 = 링크 폐기(UI_STATES §2-12 「닫기 → 다시 볼 수 없음」). */
  readonly onClose: () => void;
}

/** 클립보드 쓰기. 실패·미지원이면 입력 전체 선택으로 폴백(사용자가 직접 복사). */
async function copyLink(link: string, input: HTMLInputElement | null): Promise<void> {
  try {
    if (navigator.clipboard === undefined) throw new Error('no clipboard');
    await navigator.clipboard.writeText(link);
  } catch {
    input?.focus();
    input?.select();
  }
}

/** CMP-18 초대 링크 발급 Dialog(UI_STATES §2-8): 링크·만료 시각·복사 1회 표시 + 다시 볼 수 없음 안내, 오류 → ErrorState. */
export function InviteDialog({ view, onRetry, onClose }: InviteDialogProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <Dialog title={DIALOG_TITLES.createInvite} onClose={onClose}>
      {({ titleId }) => {
        if (view.kind === 'loading') return <div className="skeleton" aria-busy="true" />;
        if (view.kind === 'error') {
          return <ErrorState message={failureText(view.failure)} {...(isRetryable(view.failure) ? { onRetry } : {})} />;
        }
        return (
          <div className="dialog-form invite-dialog">
            {/* 시안 10 dialog: 링크 입력 + 복사 버튼 한 줄, 아래 만료 안내, 경고 상자. */}
            <div className="invite-link-row">
              <input ref={input} className="field" type="text" readOnly value={view.link} aria-labelledby={titleId} onFocus={(e) => e.target.select()} />
              <button type="button" className="btn btn-primary" onClick={() => void copyLink(view.link, input.current)}>
                {MEMBER_ADMIN_COPY.copy}
              </button>
            </div>
            <p className="field-hint">
              {MEMBER_ADMIN_COPY.expiresLabel} <time dateTime={view.expiresAt}>{formatExpiry(view.expiresAt)}</time>
            </p>
            <p className="invite-warning">{MEMBER_ADMIN_COPY.inviteWarning}</p>
          </div>
        );
      }}
    </Dialog>
  );
}
