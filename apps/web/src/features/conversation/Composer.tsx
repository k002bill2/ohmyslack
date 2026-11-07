import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  JUST_COMPOSED_WINDOW_MS,
  MESSAGE_BODY_MAX_CODE_POINTS,
  canSend,
  codePointLength,
  decideKey,
} from './ime.js';

export type MentionKey = 'Enter' | 'Tab' | 'Escape' | 'ArrowUp' | 'ArrowDown';

export interface ComposerProps {
  /** 입력란의 접근 가능한 이름. 정본(디자인 §6-2·UI_STATES §4-4)에 문구가 없어 호출자(W-10b)가 정한다. */
  readonly label: string;
  /** 전송 1회. 작성기는 호출 직후 비워진다(UI_STATES §2-5 전이 3 — 늦은 ACK는 작성기를 건드리지 않음). */
  readonly onSend: (body: string) => void;
  /** CMP-12 멘션 후보 열림(`aria-expanded=true`). 열려 있으면 Enter/Tab/Esc/↑/↓를 후보에 넘긴다(§7-4 순위 3). */
  readonly mentionOpen?: boolean;
  readonly onMentionKey?: (key: MentionKey) => void;
}

const LIMIT_MESSAGE = '4,000자까지 입력할 수 있습니다';

/** CMP-11 Composer — IME 안전 Enter(디자인 §7-4). 키 판정은 `ime.ts`의 순수 함수가 한다. */
export function Composer({ label, onSend, mentionOpen = false, onMentionKey }: ComposerProps) {
  const [text, setText] = useState('');
  const composing = useRef(false);
  const justComposed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearAfterComposition = useRef(false);

  const endJustComposed = () => {
    justComposed.current = false;
    clearTimeout(timer.current);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const send = () => {
    if (!canSend(text)) return;
    onSend(text);
    if (composing.current) clearAfterComposition.current = true;
    else setText('');
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

  const overLimit = codePointLength(text) > MESSAGE_BODY_MAX_CODE_POINTS;
  return (
    <div className="composer">
      <textarea
        aria-label={label}
        value={text}
        onChange={(e) => setText(e.target.value)}
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
            setText('');
          }
        }}
      />
      {overLimit && <p className="composer-limit">{LIMIT_MESSAGE}</p>}
      <button type="button" aria-label="전송" disabled={!canSend(text)} onClick={send} />
    </div>
  );
}
