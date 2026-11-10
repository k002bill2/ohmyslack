import { useRef } from 'react';
import { ATTACHMENT_COPY } from '../../../ui/copy.js';
import { COMPOSER_ACCEPT, formatBytes, type ComposerChip } from './composer-upload.js';
import './attachments.css';

export interface ComposerAttachmentsProps {
  readonly chips: readonly ComposerChip[];
  readonly full: boolean;
  readonly uploading: boolean;
  readonly onAdd: (files: readonly File[]) => void;
  readonly onRemove: (key: number) => void;
  readonly onRetry: (key: number) => void;
}

/** Composer 첨부(이미지 업로드): 파일 선택 버튼 + 칩(파일명·크기·제거) + 실패 알림 1개(`role="alert"`). Jarvis ★ 임시 결정(Q-H3). */
export function ComposerAttachments({ chips, full, uploading, onAdd, onRemove, onRetry }: ComposerAttachmentsProps) {
  const input = useRef<HTMLInputElement>(null);
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
      {/* R4 시안: 작성기 아래 줄 아이콘 버튼(접근 이름·툴팁 = 기존 「이미지 첨부」). */}
      <button
        type="button"
        className="composer-tool composer-attach"
        aria-label={ATTACHMENT_COPY.attach}
        title={ATTACHMENT_COPY.attach}
        disabled={full}
        onClick={() => input.current?.click()}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2.5" width="12" height="11" rx="2" />
            <circle cx="6" cy="6.5" r="1.25" />
            <path d="m14 11-3.5-3.5L4 14" />
          </g>
        </svg>
      </button>
      {chips.length > 0 && (
        <ul className="composer-chips" aria-busy={uploading}>
          {chips.map((c) => (
            <li key={c.key} className={`composer-chip composer-chip-${c.status}`}>
              <span className="composer-chip-name">{c.file.name}</span>
              <span className="composer-chip-size">{formatBytes(c.file.size)}</span>
              {c.status === 'uploading' && <span className="composer-chip-state">{ATTACHMENT_COPY.uploading}</span>}
              <button type="button" className="msg-action" aria-label={`${ATTACHMENT_COPY.remove}: ${c.file.name}`} onClick={() => onRemove(c.key)}>
                {ATTACHMENT_COPY.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
      {lastFailed !== undefined && (
        <div className="composer-attach-error" role="alert">
          <span>{lastFailed.error ?? ATTACHMENT_COPY.uploadFailed}</span>
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
