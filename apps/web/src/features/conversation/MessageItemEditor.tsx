import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ActionResult } from '../../data/index.js';
import { ErrorState } from '../../ui/ErrorState.js';
import { CANCEL_LABEL, MESSAGE_ACTION_COPY } from '../../ui/copy.js';
import { JUST_COMPOSED_WINDOW_MS, canSend, decideKey } from './ime.js';
import { failureView, type FailureView } from './MessageItemRules.js';

export interface MessageEditorProps {
  readonly initial: string;
  /** PATCH 요청. 성공하면 소유자가 편집기를 닫는다. */
  readonly onSave: (body: string) => Promise<ActionResult<null>>;
  readonly onCancel: () => void;
}

/** CMP-07 인라인 편집기(W-10i): 작성기와 같은 IME 안전 Enter(`ime.ts`), Esc 취소, 실패는 ErrorState. */
export function MessageEditor({ initial, onSave, onCancel }: MessageEditorProps) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<FailureView | null>(null);
  const composing = useRef(false);
  const justComposed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    input.current?.focus();
    return () => clearTimeout(timer.current);
  }, []);

  const save = async () => {
    if (saving || !canSend(text)) return;
    if (text === initial) {
      onCancel();
      return;
    }
    setSaving(true);
    setFailure(null);
    const result = await onSave(text);
    if (result.ok) return;
    setSaving(false);
    setFailure(failureView(result));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const native = e.nativeEvent;
    const decision = decideKey(
      { key: e.key, keyCode: native.keyCode, isComposing: native.isComposing, shiftKey: e.shiftKey },
      { composing: composing.current, justComposed: justComposed.current, mentionOpen: false },
    );
    if (decision === 'ime') return;
    if (decision === 'swallow-commit-enter') {
      e.preventDefault();
      justComposed.current = false;
      return;
    }
    if (e.key === 'Escape') {
      // 스레드 패널 Esc 닫기보다 먼저 — 편집 취소만 한다.
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    if (decision === 'send') {
      e.preventDefault();
      void save();
    }
  };

  return (
    <div className="msg-editor">
      <textarea
        ref={input}
        className="field"
        aria-label={MESSAGE_ACTION_COPY.edit}
        value={text}
        readOnly={saving}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onKeyUp={() => {
          justComposed.current = false;
        }}
        onCompositionStart={() => {
          composing.current = true;
          justComposed.current = false;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          justComposed.current = true;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            justComposed.current = false;
          }, JUST_COMPOSED_WINDOW_MS);
        }}
      />
      <button type="button" className="btn btn-secondary" onClick={onCancel}>
        {CANCEL_LABEL}
      </button>
      {failure !== null && <ErrorState message={failure.text} {...(failure.retryable ? { onRetry: () => void save() } : {})} />}
    </div>
  );
}
