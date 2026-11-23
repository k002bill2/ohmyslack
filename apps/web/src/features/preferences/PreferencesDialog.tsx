import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Dialog } from '../../ui/Dialog.js';
import { PREFERENCES_COPY } from '../../ui/copy.js';

/** 환경설정 섹션 하나. 섹션 추가 = 배열 항목 하나 추가(2026-11-23 영환님 지시 — 설정 항목을 계속 늘릴 구조). */
export interface PreferencesSection {
  /** 배열 안에서 고유한 키(탭·패널 id 접미사). */
  readonly id: string;
  /** 좌측 목록 이름이자 우측 패널 제목(h3). */
  readonly label: string;
  /** 목록 이름 앞 장식 아이콘(`aria-hidden` SVG). */
  readonly icon?: ReactNode;
  /** 패널 제목 아래 설명 한 줄. */
  readonly description?: string;
  readonly content: ReactNode;
}

/** 세로 탭 목록 키 이동 — 위/아래(compact 가로 줄에서는 왼/오른쪽도), Home/End. 이동 없으면 null. */
function nextIndex(key: string, index: number, count: number): number | null {
  if (key === 'ArrowDown' || key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * CMP-PreferencesDialog 「환경설정」 — 좌측 섹션 목록(APG vertical tablist, 자동 활성화) + 우측 패널(h3 제목 + 내용).
 * 섹션이 하나여도 목록을 보인다(앞으로 늘어날 구조). compact(≤640)는 CSS가 목록을 상단 가로 탭 줄로 바꾼다.
 * Esc·닫기·포커스 트랩·트리거 포커스 복귀는 `Dialog`(CMP-18) 규칙 그대로.
 */
export function PreferencesDialog({ sections, onClose }: {
  readonly sections: readonly PreferencesSection[];
  readonly onClose: () => void;
}) {
  const baseId = useId();
  const [selectedId, setSelectedId] = useState(sections[0]?.id ?? '');
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const current = sections.find((s) => s.id === selectedId) ?? sections[0];
  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const panelId = (id: string) => `${baseId}-panel-${id}`;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = sections.findIndex((s) => s.id === current?.id);
    const to = nextIndex(e.key, index, sections.length);
    const target = to === null ? undefined : sections[to];
    if (target === undefined) return;
    e.preventDefault();
    setSelectedId(target.id);
    tabs.current.get(target.id)?.focus();
  };

  return (
    <Dialog title={PREFERENCES_COPY.title} onClose={onClose}>
      <div className="preferences-body">
        <div className="preferences-tabs" role="tablist" aria-orientation="vertical" aria-label={PREFERENCES_COPY.sectionsLabel} onKeyDown={onKeyDown}>
          {sections.map((s) => {
            const selected = s.id === current?.id;
            return (
              <button
                key={s.id}
                ref={(el) => {
                  if (el === null) tabs.current.delete(s.id);
                  else tabs.current.set(s.id, el);
                }}
                type="button"
                role="tab"
                id={tabId(s.id)}
                className="preferences-tab"
                aria-selected={selected}
                aria-controls={panelId(s.id)}
                tabIndex={selected ? 0 : -1}
                onClick={() => setSelectedId(s.id)}
              >
                {s.icon}
                <span>{s.label}</span>
              </button>
            );
          })}
        </div>
        {current !== undefined && (
          <div className="preferences-panel" role="tabpanel" id={panelId(current.id)} aria-labelledby={tabId(current.id)}>
            <h3 className="preferences-panel-title">{current.label}</h3>
            {current.description !== undefined && <p className="preferences-panel-description">{current.description}</p>}
            {current.content}
          </div>
        )}
      </div>
    </Dialog>
  );
}
