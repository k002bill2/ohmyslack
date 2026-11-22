import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** 맨 아래로 보는 여유(px). 서브픽셀·마지막 줄 여백 오차를 흡수한다. */
export const PIN_THRESHOLD_PX = 24;

/** 스크롤 컨테이너가 맨 아래(임계 이내)에 있나. */
export function isAtBottom(el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX;
}

/** 관찰 중인 스크롤 상자와 직계 자식, 빠른 경로 비교용 직전 개수·첫·끝 자식. */
interface Observed {
  readonly el: HTMLElement;
  readonly ro: ResizeObserver;
  readonly mo: MutationObserver | null;
  readonly kids: ReadonlySet<Element>;
  readonly count: number;
  readonly first: Element | null;
  readonly last: Element | null;
}

/** 직계 자식 관찰 집합을 지금 DOM에 맞춘다(바뀐 차이만 observe/unobserve). */
function syncKids(o: Observed): Observed {
  const { el, ro, kids } = o;
  const next = new Set<Element>(Array.from(el.children));
  for (const k of kids) if (!next.has(k)) ro.unobserve(k);
  for (const k of next) if (!kids.has(k)) ro.observe(k);
  return { ...o, kids: next, count: el.childElementCount, first: el.firstElementChild, last: el.lastElementChild };
}

/** 빠른 경로(agy r2 #6): 개수·첫·끝 자식이 그대로면 매 렌더 O(n) 복사·비교를 건너뛴다. */
const sameEnds = (o: Observed) => o.el.childElementCount === o.count && o.el.firstElementChild === o.first && o.el.lastElementChild === o.last;

const stopObserving = (o: Observed) => {
  o.ro.disconnect();
  o.mo?.disconnect();
};

/**
 * 목록 상자 크기 변화(작성기 높이·배너·창 크기)와 직계 자식 크기 변화(늦게 레이아웃되는 이미지 첨부 — 상자 크기는 그대로라
 * 상자만 보면 놓친다, fix2 R-1)에 `onResize`를 부른다. 목록 요소가 바뀌면(빈 → 목록) 다시 관찰한다.
 * 직계 자식 집합은 렌더 뒤 빠른 경로로 확인하고, 개수·끝이 같은 중간 교체(스레드 「답글 없음」 → 답글 목록)는
 * MutationObserver(childList)가 고친다 — 실브라우저에서 그 콜백은 ResizeObserver 알림보다 먼저 돈다.
 */
function useObserveContent(ref: RefObject<HTMLElement | null>, onResize: () => void): void {
  const observed = useRef<Observed | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (observed.current !== null && observed.current.el !== el) {
      stopObserving(observed.current);
      observed.current = null;
    }
    if (el === null || typeof ResizeObserver === 'undefined') return;
    if (observed.current === null) {
      const ro = new ResizeObserver(onResize);
      ro.observe(el);
      const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
        if (observed.current?.el === el) observed.current = syncKids(observed.current);
      });
      mo?.observe(el, { childList: true });
      observed.current = { el, ro, mo, kids: new Set(), count: -1, first: null, last: null };
    }
    if (!sameEnds(observed.current)) observed.current = syncKids(observed.current);
  });
  useEffect(
    () => () => {
      if (observed.current !== null) stopObserving(observed.current);
    },
    [],
  );
}

/**
 * CMP-06 하단 고정(UI_STATES §2-4, D §6-2): 대화 전환·첫 진입 → 맨 아래.
 * 목록이 바뀌거나(새 메시지·자기 전송·수정·요약 추가) 보이는 높이가 줄면(작성기 여러 줄·배너, Codex r1 P2)
 * 직전 스크롤 위치가 맨 아래였을 때만 따라 내려가고, 위로 올려 읽는 중이면 위치를 유지한다.
 * `hold`가 true인 동안(알림 탭 앵커 처리·대상 강조 중)은 따라 내려가지 않고, true→false로 바뀌는 렌더에서 그때 위치로
 * 고정 여부를 다시 정한다 — 앵커가 가운데로 옮겼으면 해제, 대상을 못 찾아 맨 아래로 내렸으면 유지.
 * 단 `conversationKey`가 바뀐 렌더(스레드 전환)는 hold 해제와 겹쳐도 새 대상이므로 무조건 고정한다(agy r2 #1).
 * 반환값은 컨테이너의 `onScroll`에 건다.
 */
export function usePinBottom(ref: RefObject<HTMLElement | null>, conversationKey: string, hold = false): () => void {
  const pinned = useRef(true);
  const held = useRef(hold);
  const lastKey = useRef(conversationKey);
  const follow = () => {
    const el = ref.current;
    // 알림 탭 대상 강조 중(message-anchor.ts)에는 따라 내려가지 않는다 — scrollIntoView의 scroll 이벤트가 오기 전 재렌더로 되돌리지 않게.
    if (held.current) return;
    if (el !== null && pinned.current && el.querySelector('[data-highlighted="true"]') === null) el.scrollTop = el.scrollHeight;
  };
  // 대상 전환과 hold 해제를 한 effect에서 정한다 — 따로 두면 전환 렌더에서 해제 재평가가 고정을 덮어쓴다(그때 scrollTop은 옛 위치).
  useLayoutEffect(() => {
    const el = ref.current;
    if (lastKey.current !== conversationKey) {
      lastKey.current = conversationKey;
      pinned.current = true;
    } else if (held.current && !hold && el !== null) pinned.current = isAtBottom(el);
    held.current = hold;
  }, [conversationKey, hold, ref]);
  // 매 렌더 후: 내용이 바뀌었으면 고정 상태일 때만 맨 아래로(대입 1회 — 위로 읽는 중이면 아무것도 안 한다).
  useLayoutEffect(follow);
  useObserveContent(ref, follow);
  return () => {
    const el = ref.current;
    if (el !== null) pinned.current = isAtBottom(el);
  };
}
