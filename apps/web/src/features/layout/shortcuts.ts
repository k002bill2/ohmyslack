import { useEffect, useRef } from 'react';

export interface GlobalShortcutHandlers {
  /** `Ctrl/⌘+K` — 공간 전환기(D §7-3 기본 전환 수단). */
  readonly onSwitcher: () => void;
  /** `Ctrl/⌘+/` — 키보드 단축키 안내(SCR-09). */
  readonly onShortcuts: () => void;
}

/** 열린 모달(Dialog·medium 스레드 오버레이)이 있으면 그 안의 키가 먼저다 — 겹쳐 열지 않는다. */
function modalOpen(doc: Document): boolean {
  return doc.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

/**
 * 셸 밖(예: 페이지 로드 직후 `body`)에서도 받도록 `document`에 건다. 작성기 안에서도 동작한다(조합 중 제외).
 * compact는 키맵 대신 보이는 버튼(D §7-3)이라 `enabled=false`.
 */
export function useGlobalShortcuts(enabled: boolean, handlers: GlobalShortcutHandlers): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || modalOpen(document)) return;
      if (e.code === 'KeyK' || e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        latest.current.onSwitcher();
      } else if (e.key === '/' || e.code === 'Slash') {
        e.preventDefault();
        latest.current.onShortcuts();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
