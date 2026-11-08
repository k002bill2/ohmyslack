import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** 맨 아래로 보는 여유(px). 서브픽셀·마지막 줄 여백 오차를 흡수한다. */
export const PIN_THRESHOLD_PX = 24;

/** 스크롤 컨테이너가 맨 아래(임계 이내)에 있나. */
export function isAtBottom(el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX;
}

/**
 * CMP-06 하단 고정(UI_STATES §2-4, D §6-2): 대화 전환·첫 진입 → 맨 아래.
 * 목록이 바뀌거나(새 메시지·자기 전송·수정·요약 추가) 보이는 높이가 줄면(작성기 여러 줄·배너, Codex r1 P2)
 * 직전 스크롤 위치가 맨 아래였을 때만 따라 내려가고, 위로 올려 읽는 중이면 위치를 유지한다.
 * 반환값은 컨테이너의 `onScroll`에 건다.
 */
export function usePinBottom(ref: RefObject<HTMLElement | null>, conversationKey: string): () => void {
  const pinned = useRef(true);
  const observed = useRef<{ el: HTMLElement; ro: ResizeObserver } | null>(null);
  const follow = () => {
    const el = ref.current;
    // 알림 탭 대상 강조 중(message-anchor.ts)에는 따라 내려가지 않는다 — scrollIntoView의 scroll 이벤트가 오기 전 재렌더로 되돌리지 않게.
    if (el !== null && pinned.current && el.querySelector('[data-highlighted="true"]') === null) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(() => {
    pinned.current = true;
  }, [conversationKey]);
  // 매 렌더 후: 내용이 바뀌었으면 고정 상태일 때만 맨 아래로(대입 1회 — 위로 읽는 중이면 아무것도 안 한다).
  useLayoutEffect(follow);
  // 목록 상자 크기 변화(작성기 높이·배너·창 크기). 목록 요소가 바뀌면(빈 → 목록) 다시 관찰한다.
  useEffect(() => {
    const el = ref.current;
    if (observed.current?.el === el) return;
    observed.current?.ro.disconnect();
    observed.current = null;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(follow);
    ro.observe(el);
    observed.current = { el, ro };
  });
  useEffect(() => () => observed.current?.ro.disconnect(), []);
  return () => {
    const el = ref.current;
    if (el !== null) pinned.current = isAtBottom(el);
  };
}
