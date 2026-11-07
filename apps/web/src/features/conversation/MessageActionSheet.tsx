import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from '../../ui/Dialog.js';
import { CANCEL_LABEL, MESSAGE_ACTION_COPY } from '../../ui/copy.js';
import { CONVERSATION_DESIGN_COPY } from './copy.js';

/** 시트 항목 — 고른 뒤 시트를 먼저 닫고(언마운트) 소유자가 동작을 적용한다(Dialog 중첩 금지). */
export type MessageSheetAction = 'reply' | 'edit' | 'delete';

export interface MessageActionSheetProps {
  readonly author: string;
  /** 미리보기 — 일반 텍스트(HTML 해석 없음), CSS line-clamp로 2줄. */
  readonly body: string;
  readonly canReply: boolean;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly onSelect: (action: MessageSheetAction) => void;
  readonly onClose: () => void;
}

/**
 * 시안 08 / UI_STATES §3 「메시지 액션」 compact 액션 시트. 공통 Dialog(포커스 트랩·Esc·트리거 복귀)를
 * MessageItemDelete와 같은 portal로 body에 — 앱 전체가 inert가 된다. 추가 래퍼로 감싸지 않는다.
 */
export function MessageActionSheet({ author, body, canReply, canEdit, canDelete, onSelect, onClose }: MessageActionSheetProps) {
  return createPortal(
    <Dialog title={CONVERSATION_DESIGN_COPY.messageActions} onClose={onClose}>
      <div className="msg-action-sheet">
        <div className="msg-sheet-preview">
          <span className="msg-sheet-author">{author}</span>
          <p className="msg-sheet-body">{body}</p>
        </div>
        <div className="msg-sheet-items">
          {canReply && (
            <button type="button" className="msg-sheet-item" onClick={() => onSelect('reply')}>
              답글
            </button>
          )}
          {canEdit && (
            <button type="button" className="msg-sheet-item" onClick={() => onSelect('edit')}>
              {MESSAGE_ACTION_COPY.edit}
            </button>
          )}
          {canDelete && (
            <button type="button" className="msg-sheet-item msg-sheet-danger" onClick={() => onSelect('delete')}>
              {MESSAGE_ACTION_COPY.delete}
            </button>
          )}
          <button type="button" className="msg-sheet-item msg-sheet-cancel" onClick={onClose}>
            {CANCEL_LABEL}
          </button>
        </div>
      </div>
    </Dialog>,
    document.body,
  );
}

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;
const IGNORE_TARGETS = 'a, button, textarea, input';

/**
 * 길게 누르기(~500ms). 손을 떼거나·취소·이탈·10px 넘게 움직이거나·스크롤하면 취소.
 * 시트가 열리면 앱이 inert라 pointerup이 안 올 수 있어 발화 시점에 정리까지 끝낸다.
 * `contextmenu`는 누르는 동안에만 막는다(텍스트 선택 방해 최소화).
 */
export function useLongPress(enabled: boolean, onFire: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const fire = useRef(onFire);
  fire.current = onFire;

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    window.removeEventListener('scroll', cancel, true);
  }, []);

  useEffect(() => cancel, [cancel]);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    cancel();
    if (!enabled || e.button !== 0 || e.isPrimary === false) return;
    if (e.target instanceof Element && e.target.closest(IGNORE_TARGETS) !== null) return;
    origin.current = { x: e.clientX, y: e.clientY };
    window.addEventListener('scroll', cancel, true);
    timer.current = setTimeout(() => {
      cancel();
      fire.current();
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (timer.current === null) return;
    const dx = e.clientX - origin.current.x;
    const dy = e.clientY - origin.current.y;
    if (Math.hypot(dx, dy) > MOVE_TOLERANCE_PX) cancel();
  };

  const onContextMenu = (e: { preventDefault: () => void }) => {
    if (timer.current !== null) e.preventDefault();
  };

  return enabled
    ? { onPointerDown, onPointerMove, onPointerUp: cancel, onPointerCancel: cancel, onPointerLeave: cancel, onContextMenu }
    : {};
}
