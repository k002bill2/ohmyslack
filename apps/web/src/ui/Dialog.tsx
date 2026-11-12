import { createContext, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
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
function isComposingKey(e: globalThis.KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229 || e.key === 'Process';
}

/** 열린 Dialog 하나 — React 트리상 부모 Dialog 항목(없으면 null)과 상자 ref. 마운트 동안 같은 객체. */
interface OpenBox {
  readonly parent: OpenBox | null;
  readonly box: RefObject<HTMLDivElement | null>;
}

/** 바깥 Dialog 항목. context는 portal을 넘어 전달되므로 portal 자식 Dialog도 부모를 안다. */
const ParentDialog = createContext<OpenBox | null>(null);

/**
 * 열린 Dialog 스택 — 끝이 가장 위. 같은 커밋에 부모·자식이 열리면 자식 effect가 먼저 돌므로(Codex r1 P2)
 * 등록 시 **이미 등록된 자기 자손 앞**에 끼워 넣고, 그 외에는 끝에 붙인다. 그래서 「자식이 부모 위」와
 * 「나중에 연 것이 위」를 함께 지킨다(깊이 최대 규칙은 트리 다른 곳에서 나중에 연 Dialog를 자손 아래에 둔다).
 */
const openBoxes: OpenBox[] = [];

function isDescendant(entry: OpenBox, ancestor: OpenBox): boolean {
  for (let p = entry.parent; p !== null; p = p.parent) if (p === ancestor) return true;
  return false;
}

function pushOpenBox(entry: OpenBox): void {
  const at = openBoxes.findIndex((other) => isDescendant(other, entry));
  if (at === -1) openBoxes.push(entry);
  else openBoxes.splice(at, 0, entry);
}

function topBox(): HTMLElement | null | undefined {
  return openBoxes.at(-1)?.box.current;
}

/**
 * Tab/Shift+Tab을 상자 안 항목으로 순환시킨다. 처리했으면(기본 동작을 막아야 하면) true.
 * 상자 자체(복구된 포커스)·상자 밖 포커스도 「항목 밖」으로 본다 — 기본 Tab이 상자 밖으로 빠지지 않게(Codex r1 P2).
 */
function trapTab(box: HTMLElement, shiftKey: boolean): boolean {
  const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const head = items[0];
  const tail = items.at(-1);
  if (head === undefined || tail === undefined) return true;
  const active = document.activeElement;
  const outsideItems = active === box || !box.contains(active);
  if (shiftKey && (active === head || outsideItems)) {
    tail.focus();
    return true;
  }
  if (!shiftKey && (active === tail || outsideItems)) {
    head.focus();
    return true;
  }
  return false;
}

/**
 * 포커스가 BODY(배경 클릭·스크립트 blur 등)면 키가 상자 `onKeyDown`을 거치지 않는다(WCAG 2.1.2). 열린 동안
 * `document`(버블)에서 받아, **가장 위 Dialog**이고 대상이 BODY·`html`·이 Dialog가 inert로 만든 배경일 때만
 * Tab → 첫 항목, Shift+Tab → 마지막 항목, Esc → 닫기. 상자 안 키는 `onKeyDown` 몫이라 건너뛰고(중복 처리 금지),
 * 다른 레이어(나중에 열린 portal 메뉴 등)의 키는 가로채지 않는다. 포커스를 미리 끌어오지 않고 키를 누를 때만 잡는다.
 */
function trapOutsideKeys(entry: OpenBox, box: HTMLElement, background: readonly HTMLElement[], close: () => void): () => void {
  pushOpenBox(entry);
  const onKeyDown = (e: globalThis.KeyboardEvent) => {
    if (e.defaultPrevented || topBox() !== box) return;
    const target = e.target;
    if (!(target instanceof Node) || box.contains(target)) return;
    const stray = target === document.body || target === document.documentElement || background.some((el) => el.contains(target));
    if (!stray) return;
    if (e.key === 'Escape') {
      if (isComposingKey(e)) return;
      close();
    } else if (e.key === 'Tab' && trapTab(box, e.shiftKey)) {
      e.preventDefault();
    }
  };
  document.addEventListener('keydown', onKeyDown);
  return () => {
    document.removeEventListener('keydown', onKeyDown);
    openBoxes.splice(openBoxes.indexOf(entry), 1);
  };
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
 * - 포커스가 BODY·배경에 있어도 Tab·Shift+Tab·Esc가 가장 위 Dialog에 닿음(문서 수준 keydown)
 * 마운트 = 열림. 소유자는 `{open && <Dialog …/>}`로 렌더한다.
 */
export function Dialog({ title, onClose, children }: DialogProps) {
  const titleId = useId();
  const parent = useContext(ParentDialog);
  const box = useRef<HTMLDivElement>(null);
  // 부모 사슬은 마운트 동안 바뀌지 않는다 — 첫 렌더의 부모로 항목을 한 번 만든다.
  const [entry] = useState<OpenBox>(() => ({ parent, box }));
  // 마운트 effect가 한 번만 걸리므로 최신 onClose를 ref로 읽는다(문서 수준 Esc).
  const latestClose = useRef(onClose);
  useEffect(() => {
    latestClose.current = onClose;
  });

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
    const releaseKeyTrap = box.current === null ? null : trapOutsideKeys(entry, box.current, siblings, () => latestClose.current());
    return () => {
      releaseKeyTrap?.();
      releaseFocusGuard?.();
      siblings.forEach((el) => (el.inert = false));
      body.style.overflow = prevOverflow;
      if (trigger?.isConnected) trigger.focus();
    };
    // entry는 마운트 동안 같은 객체 — 사실상 마운트 1회.
  }, [entry]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      if (isComposingKey(e.nativeEvent)) return;
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'Tab' && box.current !== null && trapTab(box.current, e.shiftKey)) e.preventDefault();
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
        <ParentDialog.Provider value={entry}>{typeof children === 'function' ? children({ titleId }) : children}</ParentDialog.Provider>
      </div>
    </div>
  );
}
