/** AppShell 화면 상태(순수 리듀서). URL 라우팅은 다음 레인 — 지금은 `/`·`/c/:id`·`?thread=`에 대응하는 값만 둔다(디자인 §4-2). */
export interface ShellState {
  /** 선택된 공간(`/c/:conversationId`). null이면 공간 목록(`/`). */
  readonly conversationId: string | null;
  /** 열린 스레드 원문(`?thread=:root`). */
  readonly threadRootId: string | null;
}

export type ShellAction =
  | { readonly type: 'select-space'; readonly conversationId: string }
  | { readonly type: 'open-thread'; readonly rootId: string }
  | { readonly type: 'close-thread' }
  | { readonly type: 'back' };

export const initialShellState: ShellState = Object.freeze({ conversationId: null, threadRootId: null });

/** UI_STATES §3-3 T1–T4. */
export function shellReducer(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    case 'select-space':
      return { conversationId: action.conversationId, threadRootId: null };
    case 'open-thread':
      return state.conversationId === null ? state : { ...state, threadRootId: action.rootId };
    case 'close-thread':
      return { ...state, threadRootId: null };
    case 'back':
      return state.threadRootId !== null
        ? { ...state, threadRootId: null }
        : { conversationId: null, threadRootId: null };
  }
}

/** 공간 순환 이동(§7-3 Ctrl+Alt+↑/↓; Shift면 `eligible`로 읽지 않은 공간만). 후보가 없으면 null. */
export function adjacentSpace(
  ids: readonly string[],
  current: string | null,
  step: 1 | -1,
  eligible: (id: string) => boolean = () => true,
): string | null {
  const n = ids.length;
  const at = current === null ? -1 : ids.indexOf(current);
  const start = at === -1 && step === -1 ? n : at;
  for (let i = 1; i <= n; i += 1) {
    const id = ids[(((start + step * i) % n) + n) % n];
    if (id !== undefined && id !== current && eligible(id)) return id;
  }
  return null;
}
