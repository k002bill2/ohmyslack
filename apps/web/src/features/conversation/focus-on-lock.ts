import { useEffect, useRef, type RefObject } from 'react';

/**
 * G-52: 작성기가 안내로 바뀌는 순간(false→true) 사라진 입력란의 포커스를 `target`으로 옮긴다.
 * 포커스가 `scope` 안에 있었고 지금 body로 떨어졌을 때만 — 다른 곳(본문·사이드바·다른 작성기)의 포커스는 빼앗지 않는다.
 * 메인·스레드 작성기가 같은 커밋에서 함께 잠겨도 마지막 포커스가 있던 쪽만 가져간다.
 */
export function useFocusOnLock(locked: boolean, scope: RefObject<HTMLElement | null>, target: () => HTMLElement | null | undefined): void {
  const wasLocked = useRef(locked);
  const focusedInside = useRef(false);
  useEffect(() => {
    const inside = (node: unknown) => node instanceof Node && scope.current?.contains(node) === true;
    focusedInside.current = inside(document.activeElement);
    const onFocusIn = (e: FocusEvent) => {
      focusedInside.current = inside(e.target);
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [scope]);
  useEffect(() => {
    const active = document.activeElement;
    if (locked && !wasLocked.current && focusedInside.current && (active === null || active === document.body)) target()?.focus();
    wasLocked.current = locked;
    // target은 렌더마다 새 함수 — 전환 시점에만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);
}
