import { ATTACHMENT_FILENAME_FALLBACK_STEM, type AttachmentView } from '../../../../../../packages/shared/src/index.js';
import { ATTACHMENT_COPY, documentDownloadName } from '../../../ui/copy.js';
import { attachmentUrl } from './attachment-url.js';
import { formatBytes } from './composer-upload.js';
import { documentKindLabel } from './file-kinds.js';
import { FileName } from './FileName.js';

/** Lucide `file-text` 형태(장식). */
function FileTextIcon() {
  return (
    <svg className="doc-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
        <path d="M10 9H8M16 13H8M16 17H8" />
      </g>
    </svg>
  );
}

/** Lucide `download` 형태(장식). */
function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="m7 10 5 5 5-5M12 15V3" />
      </g>
    </svg>
  );
}

/**
 * CMP-32 DocumentAttachment — 메시지 안 문서·텍스트 행(UI_STATES §2-13, COPY_GAPS G-59–G-62).
 * 「받기」는 일반 `<a download>` 링크(서버 `Content-Disposition: attachment`) — JS fetch·blob 없음(UI-D5, B7).
 * 사람·봇 문서가 같은 DOM이다(UI-D9). 만료면 「받기」·크기 없이 자리표시자만.
 */
export function DocumentAttachment({ attachment }: { readonly attachment: AttachmentView }) {
  const filename = attachment.filename ?? ATTACHMENT_FILENAME_FALLBACK_STEM;
  const kind = documentKindLabel(attachment.mime) ?? '';
  const macros = attachment.has_macros === true;
  const size = formatBytes(attachment.byte_size);
  return (
    <div className={attachment.expired ? 'attachment doc-attachment doc-attachment-expired' : 'attachment doc-attachment'}>
      <FileTextIcon />
      <div className="doc-main">
        <span className="doc-head">
          <span className="doc-kind">{kind}</span>
          <FileName name={filename} base="doc-name" />
        </span>
        {attachment.expired ? (
          <span className="doc-meta">{ATTACHMENT_COPY.expired}</span>
        ) : (
          <span className="doc-meta">
            <span className="doc-size">{size}</span>
            {macros && <span className="doc-macros">{ATTACHMENT_COPY.macros}</span>}
          </span>
        )}
      </div>
      {!attachment.expired && (
        <a
          className="doc-download"
          href={attachmentUrl(attachment.id)}
          // 값 없는 download: 저장 파일명은 서버 Content-Disposition 하나가 정한다(QA iPhone r2 W2).
          download=""
          aria-label={documentDownloadName(filename, kind, size, macros)}
        >
          <DownloadIcon />
          <span>{ATTACHMENT_COPY.download}</span>
        </a>
      )}
    </div>
  );
}
