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
 * 안 포커스 요소가 요청 중 `disabled`가 되거나 제거되면 브라우저는 포커스를 BODY로 보낸다(포커스 fixup) —
 * 그러면 Esc(`onKeyDown`)·Tab 트랩이 닿지 않는다(WCAG 2.1.2·2.4.3). 상자 안에서 마지막으로 포커스된 요소를
 * 기억해, **그 요소가** disabled·제거됐고 포커스가 BODY(또는 그 요소)에 있을 때만 상자(tabIndex -1)로 되돌린다.
 * 의도적 blur 뒤 무관한 변경·사용자가 밖으로 옮긴 포커스는 건드리지 않는다(Codex r2 P2).
 * MutationObserver가 없는 환경에서는 설치를 생략한다(Codex r2 P3). 반환값은 정리 함수.
 */
function observeLostFocus(box: HTMLElement): () => void {
  if (typeof MutationObserver === 'undefined') return () => undefined;
  let tracked: Element | null = box.contains(document.activeElement) ? document.activeElement : null;
  const onFocusIn = (e: FocusEvent) => {
    if (e.target instanceof Element) tracked = e.target;
  };
  box.addEventListener('focusin', onFocusIn);
  const observer = new MutationObserver(() => {
    if (tracked === null || tracked === box) return;
    const gone = !box.contains(tracked) || tracked.matches(':disabled');
    const active = document.activeElement;
    if (gone && (active === null || active === document.body || active === tracked)) box.focus();
  });
  observer.observe(box, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
  return () => {
    observer.disconnect();
    box.removeEventListener('focusin', onFocusIn);
  };
}

/**
 * CMP-18 Dialog — APG modal dialog(UI_STATES §2-8, D §7-2·§7-3).
 * - `role="dialog"` + `aria-modal="true"`, 제목 `aria-labelledby`
 * - Tab/Shift+Tab 포커스 트랩, Esc 닫기(IME 조합 중 Esc 무시), 닫기 버튼(접근 이름 「닫기」)
 * - 열릴 때 포커스를 안으로(첫 입력·버튼), **언마운트 시 열기 직전 포커스(트리거)로 복귀**
 * - 열려 있는 동안 `body` 스크롤 잠금
 * - 안 포커스 요소가 disabled·제거로 포커스를 잃으면 상자로 되돌림(요청 중에도 Esc·Tab 동작)
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
    // 배경 비활성: 오버레이의 형제(사이드바·본문·스레드)를 `inert`로 — 포인터·포커스·보조기기 모두 막는다(Codex r1 P1).
    const backdrop = box.current?.parentElement;
    const siblings = [...(backdrop?.parentElement?.children ?? [])].filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== backdrop && !el.inert,
    );
    siblings.forEach((el) => (el.inert = true));
    const releaseFocusGuard = box.current === null ? null : observeLostFocus(box.current);
    return () => {
      releaseFocusGuard?.();
      siblings.forEach((el) => (el.inert = false));
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
    // 상자 자체(복구된 포커스)도 「항목 밖」으로 본다 — 기본 Shift+Tab이 상자 밖으로 빠지지 않게(Codex r1 P2).
    const outsideItems = active === box.current || !box.current?.contains(active);
    if (e.shiftKey && (active === head || outsideItems)) {
      e.preventDefault();
      tail.focus();
    } else if (!e.shiftKey && (active === tail || outsideItems)) {
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
