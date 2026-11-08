import { useCallback, useLayoutEffect, useState, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';

/** D §7-3 「메시지에서 R / E / Delete」 — 답글 / 수정(내 것) / 삭제(내 것, 확인 다이얼로그). */
export type MessageKeyAction = 'reply' | 'edit' | 'delete';

export interface MessageKeyCaps {
  readonly reply: boolean;
  readonly edit: boolean;
  readonly delete: boolean;
}

/** IME 조합 중 키는 IME가 먼저(D §7-4 순위 1). */
function composing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229 || e.key === 'Process';
}

/**
 * 메시지 항목 자체에 포커스가 있을 때만(입력·버튼 안 제외 — D §7-3 「입력 중이 아닐 때만」) 단축키를 판정한다.
 * R·E는 물리 키(`code`)로 본다 — 한글 자판 상태에서도 같은 키. 삭제는 정본 `Delete`에 더해 맥 키보드의 `Backspace`도
 * 받는다(맥에는 Delete 키가 없음 — 가정, W-16 QA_REPORT F-1).
 */
export function messageKeyAction(e: KeyboardEvent, caps: MessageKeyCaps): MessageKeyAction | null {
  if (e.target !== e.currentTarget || composing(e) || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.code === 'KeyR' && !e.shiftKey && caps.reply) return 'reply';
  if (e.code === 'KeyE' && !e.shiftKey && caps.edit) return 'edit';
  if ((e.key === 'Delete' || e.key === 'Backspace') && caps.delete) return 'delete';
  return null;
}

const INNER_FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';
const MARK = 'data-roving-off';

/**
 * roving tabindex 항목 쪽: 활성이 아닌 항목 안의 조작은 Tab 순서에서 뺀다(목록 = Tab 정류장 하나, UI_STATES §4-1).
 * 활성 항목 안의 버튼은 Tab으로 닿는다(다시 시도·스레드 요약 등 단축키가 없는 조작 — 가정, QA_REPORT F-1).
 * `active === undefined`(스레드 패널 등 roving 밖)면 아무것도 바꾸지 않는다. 자식이 새로 그려질 수 있어 매 렌더 적용한다.
 */
export function useRovingInner(item: RefObject<HTMLElement | null>, active: boolean | undefined): void {
  useLayoutEffect(() => {
    const root = item.current;
    if (root === null || active === undefined) return;
    for (const el of root.querySelectorAll<HTMLElement>(INNER_FOCUSABLE)) {
      if (!active && el.getAttribute('tabindex') === null) {
        el.setAttribute('tabindex', '-1');
        el.setAttribute(MARK, '');
      } else if (active && el.hasAttribute(MARK)) {
        el.removeAttribute('tabindex');
        el.removeAttribute(MARK);
      }
    }
  });
}

const ITEM = 'li[data-message-id]';

/**
 * roving tabindex 목록 쪽(UI_STATES §4-1, Q-10): 활성 항목 1개(기본 마지막 메시지)만 Tab 정류장.
 * 목록 안 이동 키는 정본에 없어 APG 목록 관례 `↑/↓`·`Home/End`로 정했다(가정, QA_REPORT F-1).
 * 포커스가 항목(또는 그 안)으로 들어오면 그 항목이 활성이 된다 — 마우스로 눌러도 Tab 복귀 지점이 맞게.
 */
export function useMessageRoving(list: RefObject<HTMLElement | null>, ids: readonly string[]) {
  const [chosen, setChosen] = useState<string | null>(null);
  const activeId = chosen !== null && ids.includes(chosen) ? chosen : (ids.at(-1) ?? null);

  const onFocus = useCallback((e: FocusEvent<HTMLElement>) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>(ITEM)?.dataset['messageId'];
    if (id !== undefined) setChosen(id);
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      if (!target.matches(ITEM) || composing(e) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const items = [...(list.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
      const at = items.indexOf(target);
      const next =
        e.key === 'ArrowUp' ? items[Math.max(at - 1, 0)]
        : e.key === 'ArrowDown' ? items[Math.min(at + 1, items.length - 1)]
        : e.key === 'Home' ? items[0]
        : e.key === 'End' ? items.at(-1)
        : undefined;
      if (next === undefined) return;
      e.preventDefault();
      next.focus();
    },
    [list],
  );

  return { activeId, onFocus, onKeyDown };
}
