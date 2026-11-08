import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { AttachmentView } from '../../../../../../packages/shared/src/index.js';
import { Dialog } from '../../../ui/Dialog.js';
import { ATTACHMENT_COPY } from '../../../ui/copy.js';
import { attachmentUrl } from './attachment-url.js';

/**
 * CMP-29 ImageAttachment — 썸네일 `<img loading="lazy">`(가로 넘침 0), 탭하면 CMP-18 Dialog로 확대. Jarvis ★ 임시 결정(Q-H2).
 * 만료면 src 없이 자리표시자. 불러오기 실패(404 등)도 깨진 이미지 대신 자리표시자로 바꾸고 다시 요청하지 않는다.
 */
export function ImageAttachment({ attachment }: { readonly attachment: AttachmentView }) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  if (attachment.expired || broken) return <p className="attachment-expired">{ATTACHMENT_COPY.expired}</p>;
  const src = attachmentUrl(attachment.id);
  const size = {
    ...(typeof attachment.width === 'number' ? { width: attachment.width } : {}),
    ...(typeof attachment.height === 'number' ? { height: attachment.height } : {}),
  };
  return (
    <div className="attachment attachment-image">
      <button type="button" className="attachment-image-open" onClick={() => setOpen(true)}>
        <img className="attachment-thumb" src={src} alt={ATTACHMENT_COPY.imageAlt} loading="lazy" {...size} onError={() => setBroken(true)} />
      </button>
      {/* body 직속 portal — Dialog가 backdrop 형제(앱 전체)를 inert로 만든다(Codex r1 P2, DeleteMessageDialog와 같은 구조). */}
      {open &&
        createPortal(
          <Dialog title={ATTACHMENT_COPY.imageDialogTitle} onClose={() => setOpen(false)}>
            <img className="attachment-full" src={src} alt={ATTACHMENT_COPY.imageAlt} onError={() => setOpen(false)} />
          </Dialog>,
          document.body,
        )}
    </div>
  );
}
