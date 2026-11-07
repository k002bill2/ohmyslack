import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { DIALOG_CLOSE_LABEL } from './copy.js';

export interface DialogProps {
  /** 제목(G-26). `aria-labelledby`로 연결된다. */
  readonly title: string;
  /** Esc·닫기(x)·완료 시 호출. 소유자가 Dialog를 언마운트하면 트리거로 포커스가 돌아간다. */
  readonly onClose: () => void;
  readonly children: ReactNode | ((ids: { readonly titleId: string }) => ReactNode);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Esc가 IME 조합 확정용이면 닫지 않는다(UI_STATES §4-3 — 조합 중 키는 IME가 먼저). */
function isComposingKey(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229 || e.key === 'Process';
}

/**
 * CMP-18 Dialog — APG modal dialog(UI_STATES §2-8, D §7-2·§7-3).
 * - `role="dialog"` + `aria-modal="true"`, 제목 `aria-labelledby`
 * - Tab/Shift+Tab 포커스 트랩, Esc 닫기(IME 조합 중 Esc 무시), 닫기 버튼(접근 이름 「닫기」)
 * - 열릴 때 포커스를 안으로(첫 입력·버튼), **언마운트 시 열기 직전 포커스(트리거)로 복귀**
 * - 열려 있는 동안 `body` 스크롤 잠금
 * 마운트 = 열림. 소유자는 `{open && <Dialog …/>}`로 렌더한다.
 */
export function Dialog({ title, onClose, children }: DialogProps) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const body = document.body;
    const prevOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    const first = box.current?.querySelector<HTMLElement>('input, select, textarea') ?? box.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? box.current)?.focus();
    return () => {
      body.style.overflow = prevOverflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      if (isComposingKey(e)) return;
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const head = items[0];
    const tail = items.at(-1);
    if (head === undefined || tail === undefined) {
      e.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (e.shiftKey && (active === head || !box.current?.contains(active))) {
      e.preventDefault();
      tail.focus();
    } else if (!e.shiftKey && (active === tail || !box.current?.contains(active))) {
      e.preventDefault();
      head.focus();
    }
  };

  return (
    <div className="dialog-backdrop">
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="dialog-header">
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          <button type="button" className="dialog-close" onClick={onClose}>
            {DIALOG_CLOSE_LABEL}
          </button>
        </div>
        {typeof children === 'function' ? children({ titleId }) : children}
      </div>
    </div>
  );
}
