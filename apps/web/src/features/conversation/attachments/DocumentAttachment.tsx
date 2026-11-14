import { useRef, useState, type MouseEvent } from 'react';
import { ATTACHMENT_FILENAME_FALLBACK_STEM, type AttachmentView } from '../../../../../../packages/shared/src/index.js';
import { ATTACHMENT_COPY, documentDownloadName } from '../../../ui/copy.js';
import { attachmentUrl } from './attachment-url.js';
import { formatBytes } from './composer-upload.js';
import { downloadLinkTarget, isStandaloneDisplay } from './download-link.js';
import { isAttachmentGone } from './expiry-check.js';
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
 * 「받기」는 일반 `<a download>` 링크(서버 `Content-Disposition: attachment`) — 바이트를 JS로 받지 않는다(UI-D5, B7).
 * 단, 누를 때 `HEAD`로 만료만 먼저 확인한다(QA iPhone r2 W3 — 화면을 연 뒤 만료되면 오류 JSON이 파일로 내려오던 문제).
 * 사람·봇 문서가 같은 DOM이다(UI-D9). 만료면 「받기」·크기 없이 자리표시자만.
 * standalone(홈 화면 앱)에서 iOS가 직접 렌더하는 형식은 새 창으로 받는다 — 창 전체가 뷰어로 바뀌어 돌아올 수 없던 문제(QA iPhone r2 W1).
 */
/**
 * 「받기」 클릭 처리: 기본 동작을 잠시 막고 HEAD로 만료를 확인한 뒤, 만료면 `onGone`, 아니면 같은 링크를 다시 눌러
 * 원래 링크 동작(다운로드·새 창)을 그대로 진행한다. 보조키·가운데 버튼 클릭은 확인 없이 브라우저에 맡긴다.
 */
function useExpiryCheckedClick(href: string, onGone: () => void, skip: boolean) {
  const passThrough = useRef(false);
  const checking = useRef(false);
  return (e: MouseEvent<HTMLAnchorElement>) => {
    // 새 창(target=_blank) 링크는 확인하지 않는다: HEAD 뒤 재클릭은 사용자 제스처 밖이라 iOS 팝업 차단에 걸릴 수 있다.
    if (skip) return;
    if (passThrough.current) {
      passThrough.current = false;
      return;
    }
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (checking.current) return;
    checking.current = true;
    const link = e.currentTarget;
    void isAttachmentGone(href).then((gone) => {
      checking.current = false;
      if (gone) {
        onGone();
        return;
      }
      if (!link.isConnected) return;
      passThrough.current = true;
      link.click();
    });
  };
}

export function DocumentAttachment({ attachment }: { readonly attachment: AttachmentView }) {
  const [goneSinceRender, setGone] = useState(false);
  const href = attachmentUrl(attachment.id);
  const target = downloadLinkTarget(attachment.mime, isStandaloneDisplay());
  const onDownloadClick = useExpiryCheckedClick(href, () => setGone(true), target.target === '_blank');
  const expired = attachment.expired || goneSinceRender;
  const filename = attachment.filename ?? ATTACHMENT_FILENAME_FALLBACK_STEM;
  const kind = documentKindLabel(attachment.mime) ?? '';
  const macros = attachment.has_macros === true;
  const size = formatBytes(attachment.byte_size);
  return (
    <div className={expired ? 'attachment doc-attachment doc-attachment-expired' : 'attachment doc-attachment'}>
      <FileTextIcon />
      <div className="doc-main">
        <span className="doc-head">
          <span className="doc-kind">{kind}</span>
          <FileName name={filename} base="doc-name" />
        </span>
        {expired ? (
          <span className="doc-meta">{ATTACHMENT_COPY.expired}</span>
        ) : (
          <span className="doc-meta">
            <span className="doc-size">{size}</span>
            {macros && <span className="doc-macros">{ATTACHMENT_COPY.macros}</span>}
          </span>
        )}
      </div>
      {!expired && (
        <a
          className="doc-download"
          href={href}
          // 값 없는 download: 저장 파일명은 서버 Content-Disposition 하나가 정한다(QA iPhone r2 W2).
          // 새 창 형식(target=_blank)은 download를 렌더하지 않는다 — WebKit이 target을 무시하기 때문(FIX2).
          download={target.download ? '' : undefined}
          target={target.target}
          rel={target.rel}
          onClick={onDownloadClick}
          aria-label={documentDownloadName(filename, kind, size, macros)}
        >
          <DownloadIcon />
          <span>{ATTACHMENT_COPY.download}</span>
        </a>
      )}
    </div>
  );
}
