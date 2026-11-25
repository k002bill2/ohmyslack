import type { RefObject } from 'react';
import { prefersNoAutoKeyboard } from '../../ui/no-auto-keyboard.js';

/** 본문 영역: 작성기 입력란 → 잠긴 DM 안내 → 메시지 목록(tabIndex=-1, 터치 기기 폴백). */
export const MAIN_DISCARD_FOCUS = ["[data-composer='main'] .composer-input", ':scope > .composer-notice', '.message-list'] as const;
/** 스레드 패널: 스레드 작성기 → 스레드 안내 → 제목(tabIndex=-1) → 「닫기」. */
export const THREAD_DISCARD_FOCUS = [":scope > [data-composer='thread'] .composer-input", ":scope > [data-composer='thread'] > .composer-notice", '.thread-title', '.thread-close'] as const;

/** 프로그래밍 focus 시 가상 키보드를 띄우는 대상. */
const TEXT_ENTRY = 'textarea, input, [contenteditable]:not([contenteditable="false"])';

/**
 * a11y-focus-order 항목 2(WCAG 2.4.3): 실패 항목 「삭제」·「목록에서 지우기」로 항목이 사라지면 포커스가 body로 떨어진다.
 * 버튼 포커스가 `scope` 안에 있을 때만(다른 영역 포커스는 빼앗지 않는다) 같은 영역의 첫 대상(`targets` 순서)으로 먼저 옮긴 뒤 지운다.
 * 터치 기기(`prefersNoAutoKeyboard`)는 입력란을 건너뛰어 키보드가 뜨지 않게 한다. 실제로 포커스가 잡힌 대상에서 멈춘다.
 */
type Discard = (clientMessageId: string) => void;
export function withDiscardFocus(scope: RefObject<HTMLElement | null>, onDiscard: Discard, targets: readonly string[]): Discard;
export function withDiscardFocus(scope: RefObject<HTMLElement | null>, onDiscard: Discard | undefined, targets: readonly string[]): Discard | undefined;
export function withDiscardFocus(scope: RefObject<HTMLElement | null>, onDiscard: Discard | undefined, targets: readonly string[]): Discard | undefined {
  if (onDiscard === undefined) return undefined;
  return (clientMessageId) => {
    const root = scope.current;
    if (root !== null && root.contains(document.activeElement)) moveFocus(root, targets, prefersNoAutoKeyboard());
    onDiscard(clientMessageId);
  };
}

function moveFocus(root: HTMLElement, targets: readonly string[], skipText: boolean): void {
  for (const selector of targets) {
    const el = root.querySelector<HTMLElement>(selector);
    if (el === null) continue;
    if (skipText && el.matches(TEXT_ENTRY)) continue;
    // 터치 기기의 비입력 폴백(제목·목록)은 스크롤을 옮기지 않는다. 데스크톱은 기존 그대로.
    el.focus(skipText ? { preventScroll: true } : undefined);
    if (document.activeElement === el) return;
  }
}
