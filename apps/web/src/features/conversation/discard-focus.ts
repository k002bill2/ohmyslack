import type { RefObject } from 'react';

/** 본문 영역: 작성기 입력란 → 잠긴 DM 안내. */
export const MAIN_DISCARD_FOCUS = ["[data-composer='main'] .composer-input", ':scope > .composer-notice'] as const;
/** 스레드 패널: 스레드 작성기 → 스레드 안내 → 「닫기」. */
export const THREAD_DISCARD_FOCUS = [':scope > .composer .composer-input', ':scope > .composer-notice', '.thread-close'] as const;

/**
 * a11y-focus-order 항목 2(WCAG 2.4.3): 실패 항목 「삭제」·「목록에서 지우기」로 항목이 사라지면 포커스가 body로 떨어진다.
 * 버튼 포커스가 `scope` 안에 있을 때만(다른 영역 포커스는 빼앗지 않는다) 같은 영역의 첫 대상(`targets` 순서)으로 먼저 옮긴 뒤 지운다.
 */
export function withDiscardFocus(
  scope: RefObject<HTMLElement | null>,
  onDiscard: ((clientMessageId: string) => void) | undefined,
  targets: readonly string[],
): ((clientMessageId: string) => void) | undefined {
  if (onDiscard === undefined) return undefined;
  return (clientMessageId) => {
    const root = scope.current;
    if (root !== null && root.contains(document.activeElement)) {
      for (const selector of targets) {
        const el = root.querySelector<HTMLElement>(selector);
        if (el !== null) {
          el.focus();
          break;
        }
      }
    }
    onDiscard(clientMessageId);
  };
}
