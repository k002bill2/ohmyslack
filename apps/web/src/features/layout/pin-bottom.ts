import { useLayoutEffect, useRef, type RefObject } from 'react';

/** 맨 아래로 보는 여유(px). 서브픽셀·마지막 줄 여백 오차를 흡수한다. */
export const PIN_THRESHOLD_PX = 24;

/** 스크롤 컨테이너가 맨 아래(임계 이내)에 있나. */
export function isAtBottom(el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX;
}

/**
 * CMP-06 하단 고정(UI_STATES §2-4, D §6-2): 대화 전환·첫 진입 → 맨 아래.
 * 목록이 바뀌면(새 메시지·자기 전송) 직전 스크롤 위치가 맨 아래였을 때만 따라 내려가고, 위로 올려 읽는 중이면 위치를 유지한다.
 * 반환값은 컨테이너의 `onScroll`에 건다.
 */
export function usePinBottom(ref: RefObject<HTMLElement | null>, conversationKey: string, contentKey: string): () => void {
  const pinned = useRef(true);
  useLayoutEffect(() => {
    pinned.current = true;
    const el = ref.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [ref, conversationKey]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el !== null && pinned.current) el.scrollTop = el.scrollHeight;
  }, [ref, contentKey]);
  return () => {
    const el = ref.current;
    if (el !== null) pinned.current = isAtBottom(el);
  };
}
