import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  JUST_COMPOSED_WINDOW_MS,
  MESSAGE_BODY_MAX_CODE_POINTS,
  canSend,
  codePointLength,
  decideKey,
} from './ime.js';
import type { DraftStore } from './drafts.js';
import { COMPOSER_COPY, overText, remainingText } from '../../ui/copy.js';

export type MentionKey = 'Enter' | 'Tab' | 'Escape' | 'ArrowUp' | 'ArrowDown';

export interface ComposerProps {
  /** 입력란의 접근 가능한 이름. 정본(디자인 §6-2·UI_STATES §4-4)에 문구가 없어 호출자(W-10b)가 정한다. */
  readonly label: string;
  /** placeholder(G-28). 라벨을 대신하지 않는다. */
  readonly placeholder?: string;
  /** 전송 1회. 작성기는 호출 직후 비워진다(UI_STATES §2-5 전이 3 — 늦은 ACK는 작성기를 건드리지 않음). */
  readonly onSend: (body: string) => void;
  /** CMP-12 멘션 후보 열림(`aria-expanded=true`). 열려 있으면 Enter/Tab/Esc/↑/↓를 후보에 넘긴다(§7-4 순위 3). */
  readonly mentionOpen?: boolean;
  readonly onMentionKey?: (key: MentionKey) => void;
  /** 대상별 초안 보존(디자인 §7-3 초안 규칙). 마운트 시 복원하고 입력마다 저장, 전송으로 비우면 지운다. */
  readonly draft?: { readonly store: DraftStore; readonly key: string };
}

const LIMIT_MESSAGE = COMPOSER_COPY.limit;
/** G-30: 3,800 code point부터 카운터를 보이고, 스크린리더에는 3,800·3,900·4,000 지점에서만 알린다. */
export const COUNTER_START = 3_800;
const ANNOUNCE_POINTS = [4_000, 3_900, 3_800] as const;

/** 화면 카운터 문구(없으면 null). */
export function counterText(length: number, max: number): string | null {
  if (length < COUNTER_START) return null;
  return length > max ? overText(length - max) : remainingText(max - length);
}

/** aria-live 문구 — 지점을 지날 때만 바뀐다. 상한 초과면 정본 상한 문구. */
export function counterAnnouncement(length: number, max: number): string {
  if (length > max) return LIMIT_MESSAGE;
  const point = ANNOUNCE_POINTS.find((p) => length >= p);
  return point === undefined ? '' : remainingText(max - point);
}

/** CMP-11 Composer — IME 안전 Enter(디자인 §7-4). 키 판정은 `ime.ts`의 순수 함수가 한다. */
export function Composer({ label, placeholder, onSend, mentionOpen = false, onMentionKey, draft }: ComposerProps) {
  const [text, setText] = useState(() => draft?.store.get(draft.key) ?? '');
  const composing = useRef(false);
  const justComposed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearAfterComposition = useRef(false);

  const endJustComposed = () => {
    justComposed.current = false;
    clearTimeout(timer.current);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const updateText = (next: string) => {
    setText(next);
    draft?.store.set(draft.key, next);
  };

  const send = () => {
    if (!canSend(text)) return;
    onSend(text);
    draft?.store.delete(draft.key);
    if (composing.current) clearAfterComposition.current = true;
    else updateText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const native = e.nativeEvent;
    const decision = decideKey(
      { key: e.key, keyCode: native.keyCode, isComposing: native.isComposing, shiftKey: e.shiftKey },
      { composing: composing.current, justComposed: justComposed.current, mentionOpen },
    );
    if (decision === 'swallow-commit-enter') {
      e.preventDefault();
      endJustComposed();
    } else if (decision === 'mention') {
      e.preventDefault();
      onMentionKey?.(e.key as MentionKey);
    } else if (decision === 'send') {
      e.preventDefault();
      send();
    }
  };

  const length = codePointLength(text);
  const overLimit = length > MESSAGE_BODY_MAX_CODE_POINTS;
  const counter = counterText(length, MESSAGE_BODY_MAX_CODE_POINTS);
  return (
    <div className="composer">
      <textarea
        aria-label={label}
        placeholder={placeholder}
        value={text}
        onChange={(e) => updateText(e.target.value)}
        onKeyDown={onKeyDown}
        onKeyUp={endJustComposed}
        onCompositionStart={() => {
          composing.current = true;
          endJustComposed();
        }}
        onCompositionEnd={() => {
          composing.current = false;
          justComposed.current = true;
          clearTimeout(timer.current);
          timer.current = setTimeout(endJustComposed, JUST_COMPOSED_WINDOW_MS);
          if (clearAfterComposition.current) {
            clearAfterComposition.current = false;
            updateText('');
          }
        }}
      />
      {counter !== null && (
        <p className="composer-counter" aria-hidden="true">
          {counter}
        </p>
      )}
      {/* 상한 초과면 정본 상한 문구를 화면에도 보인다(같은 노드가 알림을 겸한다). */}
      <p className={overLimit ? 'composer-limit' : 'visually-hidden'} aria-live="polite">
        {counterAnnouncement(length, MESSAGE_BODY_MAX_CODE_POINTS)}
      </p>
      <button type="button" aria-label="전송" disabled={!canSend(text)} onClick={send} />
    </div>
  );
}
