import { useRef } from 'react';
import { ATTACHMENT_COPY } from '../../../ui/copy.js';
import { formatBytes, type ComposerChip } from './composer-upload.js';
import { COMPOSER_ACCEPT, composerKindLabel } from './file-kinds.js';
import './attachments.css';

export interface ComposerAttachmentsProps {
  readonly chips: readonly ComposerChip[];
  readonly full: boolean;
  readonly uploading: boolean;
  readonly onAdd: (files: readonly File[]) => void;
  readonly onRemove: (key: number) => void;
  readonly onRetry: (key: number) => void;
  /** 마지막 칩이 사라졌을 때 포커스 대상(작성기 입력란, UI_STATES §2-13 「사라진 트리거」). */
  readonly onEmptied?: () => void;
}

/**
 * Composer 첨부(이미지·문서 업로드, UI_STATES §2-6·§2-13): 「파일 첨부」 버튼(G-53) + 칩(형식 표지·파일명·크기·제거) + 실패 알림 1개(`role="alert"`).
 * 제거 뒤 포커스: 다음 칩의 「첨부 제거」 → 없으면 이전 칩 → 없으면 입력란.
 */
export function ComposerAttachments({ chips, full, uploading, onAdd, onRemove, onRetry, onEmptied }: ComposerAttachmentsProps) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const removeAndRefocus = (key: number) => {
    const index = chips.findIndex((c) => c.key === key);
    const target = chips[index + 1] ?? chips[index - 1];
    onRemove(key);
    if (target === undefined) {
      onEmptied?.();
      return;
    }
    // 다음 렌더 뒤에도 남는 칩의 제거 버튼(키로 찾는다).
    queueMicrotask(() => list.current?.querySelector<HTMLButtonElement>(`[data-chip-key="${target.key}"]`)?.focus());
  };
  const failed = chips.filter((c) => c.status === 'failed');
  const lastFailed = failed[failed.length - 1];
  return (
    <div className="composer-attachments">
      <input
        ref={input}
        type="file"
        className="visually-hidden"
        accept={COMPOSER_ACCEPT}
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          onAdd(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      {/* R4 시안: 작성기 아래 줄 아이콘 버튼(`paperclip`, 접근 이름·툴팁 = 「파일 첨부」 G-53). */}
      <button
        type="button"
        className="composer-tool composer-attach"
        aria-label={ATTACHMENT_COPY.attach}
        title={ATTACHMENT_COPY.attach}
        disabled={full}
        onClick={() => input.current?.click()}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
          <path
            d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {chips.length > 0 && (
        <ul ref={list} className="composer-chips" aria-busy={uploading}>
          {chips.map((c) => {
            const label = composerKindLabel(c.file.name);
            return (
              <li key={c.key} className={`composer-chip composer-chip-${c.status}`} aria-busy={c.status === 'uploading'}>
                {label !== null && <span className="composer-chip-kind">{label}</span>}
                <span className="composer-chip-name" title={c.file.name}>
                  {c.file.name}
                </span>
                <span className="composer-chip-size">{formatBytes(c.file.size)}</span>
                {c.status === 'uploading' && (
                  <span className="composer-chip-state">
                    <span className="composer-chip-progress" aria-hidden="true" />
                    {ATTACHMENT_COPY.uploading}
                  </span>
                )}
                <button
                  type="button"
                  className="msg-action"
                  data-chip-key={c.key}
                  aria-label={`${ATTACHMENT_COPY.remove}: ${c.file.name}`}
                  onClick={() => removeAndRefocus(c.key)}
                >
                  {ATTACHMENT_COPY.remove}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {lastFailed !== undefined && (
        <div className="composer-attach-error" role="alert">
          <span>{lastFailed.error ?? ATTACHMENT_COPY.unsupported}</span>
          {lastFailed.retryable !== false && (
            <button type="button" className="msg-action" onClick={() => onRetry(lastFailed.key)}>
              {ATTACHMENT_COPY.retry}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
