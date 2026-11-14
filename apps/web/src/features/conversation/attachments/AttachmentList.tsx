import { ATTACHMENTS_PER_MESSAGE_MAX, isAttachmentFileMime, type AttachmentView } from '../../../../../../packages/shared/src/index.js';
import { AudioAttachment } from './AudioAttachment.js';
import { DocumentAttachment } from './DocumentAttachment.js';
import { ImageAttachment } from './ImageAttachment.js';
import { isAudio } from './attachment-url.js';
import './attachments.css';

/** CMP-27 AttachmentList(문서·텍스트는 CMP-32) — 메시지 본문 아래, 서버 순서 그대로 최대 `ATTACHMENTS_PER_MESSAGE_MAX`개. 사람·봇 메시지 공통. */
export function AttachmentList({ attachments }: { readonly attachments: readonly AttachmentView[] }) {
  if (attachments.length === 0) return null;
  return (
    <ul className="attachment-list">
      {attachments.slice(0, ATTACHMENTS_PER_MESSAGE_MAX).map((a) => (
        <li key={a.id} className="attachment-item">
          {isAttachmentFileMime(a.mime) ? (
            <DocumentAttachment attachment={a} />
          ) : isAudio(a) ? (
            <AudioAttachment attachment={a} />
          ) : (
            <ImageAttachment attachment={a} />
          )}
        </li>
      ))}
    </ul>
  );
}
