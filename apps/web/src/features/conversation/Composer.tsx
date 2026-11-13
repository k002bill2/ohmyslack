import { BotBadge } from '../../ui/BotBadge.js';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  JUST_COMPOSED_WINDOW_MS,
  MESSAGE_BODY_MAX_CODE_POINTS,
  canSend,
  codePointLength,
  decideKey,
} from './ime.js';
import type { DraftStore } from './drafts.js';
import { MENTION_DRAFT_SUFFIX, filterCandidates, insertMention, mentionIdsIn, mentionQuery, parseSelections, type MentionCandidate, type MentionQuery, type MentionSelection } from './mention.js';
import { ComposerAttachments } from './attachments/ComposerAttachments.js';
import { useComposerAttachments, type UploadFn } from './attachments/composer-upload.js';
import { COMPOSER_COPY, MENTION_EMPTY_TEXT, MENTION_POPOVER_COPY, overText, remainingText } from '../../ui/copy.js';
import './composer-copy.css';

export type MentionKey = 'Enter' | 'Tab' | 'Escape' | 'ArrowUp' | 'ArrowDown';

export interface ComposerProps {
  /** 입력란의 접근 가능한 이름. 정본(디자인 §6-2·UI_STATES §4-4)에 문구가 없어 호출자(W-10b)가 정한다. */
  readonly label: string;
  /** placeholder(G-28). 라벨을 대신하지 않는다. */
  readonly placeholder?: string;
  /** 전송 1회. 작성기는 호출 직후 비워진다(UI_STATES §2-5 전이 3 — 늦은 ACK는 작성기를 건드리지 않음). 멘션 ID는 CMP-12 선택분. */
  readonly onSend: (body: string, mentionUserIds?: readonly string[], attachmentIds?: readonly string[]) => void;
  /** 이미지 첨부 업로드(W-22). 있을 때만 첨부 버튼·칩을 렌더한다. 결과 ID는 `onSend` 세 번째 인자로 결속한다. */
  readonly onUpload?: UploadFn;
  /** CMP-12 멘션 후보 열림(`aria-expanded=true`). 열려 있으면 Enter/Tab/Esc/↑/↓를 후보에 넘긴다(§7-4 순위 3). */
  readonly mentionOpen?: boolean;
  readonly onMentionKey?: (key: MentionKey) => void;
  /** 대상별 초안 보존(디자인 §7-3 초안 규칙). 마운트 시 복원하고 입력마다 저장, 전송으로 비우면 지운다. */
  readonly draft?: { readonly store: DraftStore; readonly key: string };
  /** CMP-12 멘션 후보(현재 대화 참여자). 있으면 `@` 입력으로 후보 목록을 연다(자기 자신 제외). */
  readonly mentions?: { readonly candidates: readonly MentionCandidate[]; readonly selfId?: string };
  /** 작성기 도움말 표시(결정 3: wide·medium만). 표시할 때만 렌더하고 `aria-describedby`로 잇는다. */
  readonly showHint?: boolean;
  /** 멘션 팝오버 머리말 대상(채널 「이 채널의 멤버」 / DM 「이 대화의 멤버」). */
  readonly mentionScope?: 'channel' | 'dm';
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
export function Composer({ label, placeholder, onSend, onUpload, mentionOpen = false, onMentionKey, draft, mentions, showHint = false, mentionScope = 'channel' }: ComposerProps) {
  const [text, setText] = useState(() => draft?.store.get(draft.key) ?? '');
  const files = useComposerAttachments(onUpload);
  const [picker, setPicker] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  // 선택한 멘션도 초안과 함께 보존·복원한다(Codex r1 P2).
  const mentionKey = draft === undefined ? undefined : `${draft.key}${MENTION_DRAFT_SUFFIX}`;
  const [selected, setSelectedState] = useState<readonly MentionSelection[]>(() =>
    mentionKey === undefined ? [] : parseSelections(draft?.store.get(mentionKey)),
  );
  const setSelected = (next: readonly MentionSelection[]) => {
    setSelectedState(next);
    if (draft === undefined || mentionKey === undefined) return;
    if (next.length === 0) draft.store.delete(mentionKey);
    else draft.store.set(mentionKey, JSON.stringify(next));
  };
  const area = useRef<HTMLTextAreaElement>(null);
  const caretAfter = useRef<number | null>(null);
  const listId = useId();
  const hintId = useId();
  const options = picker === null || mentions === undefined ? [] : filterCandidates(mentions.candidates, picker.query, mentions.selfId);
  const pickerOpen = picker !== null && mentions !== undefined;
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

  useEffect(() => {
    if (caretAfter.current === null) return;
    area.current?.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [text]);

  /** 입력 변경 → 트리거 판정. 조합 중에는 새로 열지 않고, 이미 열린 후보만 조합 텍스트로 거른다(§2-6). */
  const onInput = (next: string, caret: number) => {
    updateText(next);
    if (mentions === undefined) return;
    const q = mentionQuery(next, caret);
    if (q === null || (composing.current && picker === null)) {
      setPicker(null);
      return;
    }
    if (picker === null || picker.start !== q.start || picker.query !== q.query) setActive(0);
    setPicker(q);
  };

  const choose = (candidate: MentionCandidate) => {
    if (picker === null) return;
    const next = insertMention(text, picker, candidate.displayName);
    updateText(next.text);
    caretAfter.current = next.caret;
    setSelected([...selected, { id: candidate.id, displayName: candidate.displayName }]);
    setPicker(null);
  };

  /** R4 `@` 버튼: 커서 자리에 `@`를 넣고 입력란으로 돌아가 후보를 연다(타이핑과 같은 onInput 경로). */
  const insertAt = () => {
    const el = area.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const before = text.slice(0, start);
    const lead = before === '' || /\s$/u.test(before) ? '@' : ' @';
    const next = `${before}${lead}${text.slice(end)}`;
    const caret = start + lead.length;
    caretAfter.current = caret;
    onInput(next, caret);
    el?.focus();
  };

  const onPickerKey = (key: MentionKey) => {
    if (key === 'Escape') setPicker(null);
    else if (key === 'ArrowDown') setActive((i) => (options.length === 0 ? 0 : (i + 1) % options.length));
    else if (key === 'ArrowUp') setActive((i) => (options.length === 0 ? 0 : (i - 1 + options.length) % options.length));
    else {
      const candidate = options[active];
      if (candidate !== undefined) choose(candidate);
    }
  };

  /** 업로드 중·실패 칩이 있으면 보내지 않는다(잘못된 attachment_ids 방지). 본문이 비어도 완료 첨부가 있으면 자리 문구로 보낸다. */
  const imageOnly = text.trim() === '' && files.ids.length > 0;
  const sendable = !files.blocked && (imageOnly || canSend(text));
  const send = () => {
    if (!sendable) return;
    const body = imageOnly ? files.placeholderBody : text;
    const ids = mentionIdsIn(text, selected);
    const attachmentIds = files.ids;
    if (attachmentIds.length > 0) onSend(body, ids.length > 0 ? ids : undefined, attachmentIds);
    else if (ids.length > 0) onSend(body, ids);
    else onSend(body);
    files.clear();
    setSelected([]);
    setPicker(null);
    draft?.store.delete(draft.key);
    if (composing.current) clearAfterComposition.current = true;
    else updateText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const native = e.nativeEvent;
    const decision = decideKey(
      { key: e.key, keyCode: native.keyCode, isComposing: native.isComposing, shiftKey: e.shiftKey },
      { composing: composing.current, justComposed: justComposed.current, mentionOpen: mentionOpen || pickerOpen },
    );
    if (decision === 'swallow-commit-enter') {
      e.preventDefault();
      endJustComposed();
    } else if (decision === 'mention') {
      e.preventDefault();
      if (pickerOpen) onPickerKey(e.key as MentionKey);
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
        ref={area}
        className="field composer-input"
        aria-label={label}
        placeholder={placeholder}
        {...(showHint ? { 'aria-describedby': hintId } : {})}
        value={text}
        {...(!pickerOpen
          ? {}
          : {
              // UI_STATES §2-6 「열림」 행: combobox + aria-expanded=true + listbox. 닫힘은 기본 textbox(기존 접근 이름 유지).
              role: 'combobox',
              'aria-autocomplete': 'list' as const,
              'aria-expanded': true,
              'aria-controls': listId,
              ...(options[active] !== undefined ? { 'aria-activedescendant': `${listId}-${active}` } : {}),
            })}
        onChange={(e) => onInput(e.target.value, e.target.selectionStart)}
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
      {pickerOpen && (
        // 팝오버 어디를 눌러도 textarea 포커스를 유지한다(키보드 이동이 끊기지 않게).
        <div className="mention-picker" onMouseDown={(e) => e.preventDefault()}>
          {/* 머리말·도움말은 listbox 밖 — 옵션 수·키보드 이동에 영향 없음(결정 3). */}
          <p className="mention-heading">
            {mentionScope === 'dm' ? MENTION_POPOVER_COPY.dmHeading : MENTION_POPOVER_COPY.channelHeading}
          </p>
          <ul className="mention-list" id={listId} role="listbox" aria-label={label}>
            {options.length === 0 ? (
              <li className="mention-empty" role="presentation">
                {MENTION_EMPTY_TEXT}
              </li>
            ) : (
              options.map((c, i) => (
                <li
                  key={c.id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'mention-option mention-active' : 'mention-option'}
                  data-initial={Array.from(c.displayName)[0] ?? ''}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(c);
                  }}
                >
                  {c.displayName}
                  {c.bot === true && (
                    <>
                      {' '}
                      <BotBadge />
                    </>
                  )}
                </li>
              ))
            )}
          </ul>
          <p className="mention-hint">
            {MENTION_POPOVER_COPY.hint}
          </p>
        </div>
      )}
      {mentions !== undefined && (
        <button type="button" className="composer-tool" aria-label={COMPOSER_COPY.mentionButton} title={COMPOSER_COPY.mentionButton} onClick={insertAt}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="2.75" />
              <path d="M10.75 5.5v3.25a2 2 0 0 0 4 0V8a6.75 6.75 0 1 0-2.7 5.4" />
            </g>
          </svg>
        </button>
      )}
      {onUpload !== undefined && (
        <ComposerAttachments
          chips={files.chips}
          full={files.full}
          uploading={files.uploading}
          onAdd={files.add}
          onRemove={files.remove}
          onRetry={files.retry}
          onEmptied={() => area.current?.focus()}
        />
      )}
      {showHint && (
        <p className="composer-hint" id={hintId}>
          {COMPOSER_COPY.hint}
        </p>
      )}
      {counter !== null && (
        <p className="composer-counter" aria-hidden="true">
          {counter}
        </p>
      )}
      {/* 상한 초과면 정본 상한 문구를 화면에도 보인다(같은 노드가 알림을 겸한다). */}
      <p className={overLimit ? 'composer-limit' : 'visually-hidden'} aria-live="polite">
        {counterAnnouncement(length, MESSAGE_BODY_MAX_CODE_POINTS)}
      </p>
      {/* 시안 01·05: 원형 아이콘 전송 버튼. 보이는 글자는 시각적으로 숨기고 접근 이름 「전송」 유지. */}
      <button
        type="button"
        className="btn btn-primary composer-send"
        aria-label="전송"
        disabled={!sendable}
        {...(files.uploading ? { 'aria-busy': true } : {})}
        onClick={send}
      >
        <svg className="composer-send-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="visually-hidden">전송</span>
      </button>
    </div>
  );
}
