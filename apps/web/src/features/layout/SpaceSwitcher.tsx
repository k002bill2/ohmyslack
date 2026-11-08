import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Space } from '../../data';
import { SPACE_SWITCHER_COPY } from '../../ui/copy.js';
import { Dialog } from '../../ui/Dialog.js';

export interface SpaceSwitcherProps {
  readonly spaces: readonly Space[];
  /** 보이는 이름(채널은 `#이름`) — 셸 헤더와 같은 규칙. */
  readonly titleOf: (space: Space) => string;
  readonly onSelect: (conversationId: string) => void;
  readonly onClose: () => void;
}

/** 확정 Enter 창(D §7-4 순위 2) — 작성기와 같은 제안값. */
const JUST_COMPOSED_WINDOW_MS = 100;

/** IME 조합 중 Enter·화살표는 IME가 먼저(D §7-4 순위 1). */
function composing(e: KeyboardEvent, active: boolean): boolean {
  return active || e.nativeEvent.isComposing || e.keyCode === 229 || e.key === 'Process';
}

/** 조합 상태와 확정 Enter 창(`compositionend` → 다음 `keyup` 또는 100ms). Composer와 같은 규칙. */
function useImeWindow() {
  const active = useRef(false);
  const justComposed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const end = () => {
    justComposed.current = false;
    clearTimeout(timer.current);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    active,
    justComposed,
    handlers: {
      onCompositionStart: () => {
        active.current = true;
        end();
      },
      onCompositionEnd: () => {
        active.current = false;
        justComposed.current = true;
        clearTimeout(timer.current);
        timer.current = setTimeout(end, JUST_COMPOSED_WINDOW_MS);
      },
      onKeyUp: end,
    },
  };
}

/** 입력이 이름(또는 `#이름`)에 들어 있는 공간 — 대소문자 무시, 목록 순서 유지. */
export function matchSpaces(spaces: readonly Space[], titleOf: (space: Space) => string, query: string): readonly Space[] {
  const q = query.trim().toLocaleLowerCase();
  if (q === '') return spaces;
  return spaces.filter((s) => s.name.toLocaleLowerCase().includes(q) || titleOf(s).toLocaleLowerCase().includes(q));
}

/**
 * 공간 전환기(D §7-3 `Ctrl/⌘+K` — 기본 전환 수단, 문구 COPY_GAPS G-33). CMP-18 Dialog 안의 APG combobox(목록 자동완성):
 * 입력으로 거르고 `↑/↓`로 후보, `Enter`로 고른다. 포커스 결과(F4: 새 공간의 작성기)는 호출자가 맡는다.
 */
export function SpaceSwitcher({ spaces, titleOf, onSelect, onClose }: SpaceSwitcherProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputId = useId();
  const listId = useId();
  const matches = matchSpaces(spaces, titleOf, query);
  const current = Math.min(active, matches.length - 1);
  const optionId = (i: number) => `${listId}-${i}`;
  const ime = useImeWindow();
  const list = useRef<HTMLUListElement>(null);
  // 활성 후보를 목록 안에서 보이게(aria-activedescendant는 스크롤하지 않는다 — APG combobox).
  // 활성 후보·검색어가 바뀔 때만 — 배경 갱신 재렌더로 사용자가 내린 스크롤을 되돌리지 않게(Codex F-1 r2).
  const activeOption = current < 0 ? null : optionId(current);
  useEffect(() => {
    if (activeOption === null) return;
    list.current?.querySelector<HTMLElement>(`[id="${activeOption}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeOption, query]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 조합 중 키는 IME 몫 — 기본 동작은 두고 Dialog(Tab 트랩·Esc)로도 넘기지 않는다.
    if (composing(e, ime.active.current)) {
      e.stopPropagation();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter' && ime.justComposed.current) {
      e.preventDefault();
      ime.justComposed.current = false;
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (matches.length === 0) return;
      setActive(e.key === 'ArrowDown' ? Math.min(current + 1, matches.length - 1) : Math.max(current - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const picked = matches[current];
      if (picked !== undefined) onSelect(picked.id);
    }
  };

  return (
    <Dialog title={SPACE_SWITCHER_COPY.title} onClose={onClose}>
      <div className="space-switcher">
        <label htmlFor={inputId}>{SPACE_SWITCHER_COPY.inputLabel}</label>
        <input
          id={inputId}
          className="field"
          type="text"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={matches.length > 0}
          aria-controls={listId}
          {...(matches.length > 0 ? { 'aria-activedescendant': optionId(current) } : {})}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          {...ime.handlers}
        />
        {matches.length === 0 ? (
          <p className="empty-state" role="status">
            {SPACE_SWITCHER_COPY.empty}
          </p>
        ) : (
          <ul ref={list} id={listId} className="space-switcher-list" role="listbox" aria-label={SPACE_SWITCHER_COPY.inputLabel}>
            {matches.map((space, i) => (
              <li
                key={space.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === current}
                className="space-switcher-option"
                // 입력 포커스를 잃지 않게 — 클릭은 그대로 고른다.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSelect(space.id)}
              >
                {titleOf(space)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
