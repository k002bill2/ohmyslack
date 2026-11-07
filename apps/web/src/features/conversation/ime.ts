/**
 * 작성기 키 처리 우선순위(디자인 §7-4 = UI_STATES §4-3, 위가 이김). 순수 함수.
 * 1 조합 보호 → 2 확정 Enter 창 → 3 멘션 후보 → 4 Shift+Enter → 5 Enter 전송 → 6 기본 편집.
 */

/** 확정 Enter 창 길이(디자인 §7-4 보조 1 제안값, 실기기 매트릭스로 조정). */
export const JUST_COMPOSED_WINDOW_MS = 100;

/** 메시지 본문 상한(TRD §5: 4,000 Unicode code point). W-08 `packages/shared` 상수가 생기면 그 값으로 교체한다. */
export const MESSAGE_BODY_MAX_CODE_POINTS = 4000;

export interface KeyInfo {
  readonly key: string;
  readonly keyCode: number;
  readonly isComposing: boolean;
  readonly shiftKey: boolean;
}

export interface ComposerKeyState {
  readonly composing: boolean;
  readonly justComposed: boolean;
  readonly mentionOpen: boolean;
}

export type KeyDecision =
  /** 순위 1: 앱은 아무것도 하지 않는다(preventDefault 없음, IME에 맡김). */
  | 'ime'
  /** 순위 2: 확정 Enter — 전송하지 않고 플래그만 내린다. */
  | 'swallow-commit-enter'
  /** 순위 3: 멘션 후보에 키를 넘긴다. */
  | 'mention'
  /** 순위 4: 줄바꿈(textarea 기본 동작). */
  | 'newline'
  /** 순위 5: 전송 시도. */
  | 'send'
  /** 순위 6: 기본 편집. */
  | 'default';

const MENTION_KEYS: ReadonlySet<string> = new Set(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown']);

export function isImeKey(e: KeyInfo, state: ComposerKeyState): boolean {
  return e.isComposing || e.keyCode === 229 || e.key === 'Process' || state.composing;
}

export function decideKey(e: KeyInfo, state: ComposerKeyState): KeyDecision {
  if (isImeKey(e, state)) return 'ime';
  if (e.key === 'Enter' && state.justComposed) return 'swallow-commit-enter';
  if (state.mentionOpen && MENTION_KEYS.has(e.key)) return 'mention';
  if (e.key === 'Enter') return e.shiftKey ? 'newline' : 'send';
  return 'default';
}

export function codePointLength(text: string): number {
  return [...text].length;
}

/** 전송 가능한 본문인가: 공백만이 아니고 상한 이내(빈 본문 거부는 서버 규칙 TRD §2와 같은 기준). */
export function canSend(text: string): boolean {
  return text.trim() !== '' && codePointLength(text) <= MESSAGE_BODY_MAX_CODE_POINTS;
}
