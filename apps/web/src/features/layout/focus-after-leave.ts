import { useEffect, useReducer, useRef, type RefObject } from 'react';
import type { ActionResult } from '../../data';

/**
 * focus-after-leave(WCAG 2.4.3): 「채널 나가기」 성공 뒤 포커스를 머리 「다시 참여」로.
 * 나가면 HeaderMenu가 LeaveChannelControl 없이 다시 그려져 확인 Dialog의 복귀 대상(「대화 더보기」)이
 * 언마운트되거나(390) 새 요소로 바뀐다(1280) → Dialog 복귀가 BODY로 떨어진다.
 * 「다시 참여」는 나간 상태가 반영된 렌더에서야 생기므로, 요청 시작 때 의도를 대화 ID로 표시해 두고
 * `left`가 참이 된 커밋 뒤 effect에서 옮긴다(반영이 응답 전이든 후든 — 성공 시 tick으로 한 번 더 확인).
 * 버튼이라 터치에서도 가상 키보드가 뜨지 않는다. 포커스가 이미 BODY 밖(사용자가 옮김)이면 빼앗지 않는다.
 */
export function useFocusAfterLeave(
  pane: RefObject<HTMLElement | null>,
  spaceId: string,
  left: boolean,
  onLeave: (() => Promise<ActionResult<null>>) | undefined,
): (() => Promise<ActionResult<null>>) | undefined {
  const pending = useRef<string | null>(null);
  const [tick, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (pending.current !== spaceId) {
      pending.current = null;
      return;
    }
    if (!left) return;
    pending.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const root = pane.current;
    const target =
      root?.querySelector<HTMLElement>('[data-rejoin="header"]') ?? root?.querySelector<HTMLElement>('.conversation-title') ?? root;
    target?.focus({ preventScroll: true });
  }, [pane, spaceId, left, tick]);

  if (onLeave === undefined) return undefined;
  return async () => {
    pending.current = spaceId;
    const res = await onLeave();
    if (!res.ok) {
      if (pending.current === spaceId) pending.current = null;
      return res;
    }
    bump();
    return res;
  };
}
