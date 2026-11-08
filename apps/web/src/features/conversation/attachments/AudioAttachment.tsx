import { useState } from 'react';
import type { AttachmentView } from '../../../../../../packages/shared/src/index.js';
import { ATTACHMENT_COPY } from '../../../ui/copy.js';
import { attachmentUrl, formatDuration } from './attachment-url.js';

/**
 * CMP-28 AudioAttachment — 네이티브 `<audio controls preload="none">` + 길이(m:ss). Jarvis ★ 임시 결정(Q-H2).
 * 재생 실패(`error`)는 문구 + 「다시 시도」(사용자 동작으로만 재시도 — 자동 재시도 없음). 만료면 src 없이 자리표시자.
 */
export function AudioAttachment({ attachment }: { readonly attachment: AttachmentView }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  if (attachment.expired) return <p className="attachment-expired">{ATTACHMENT_COPY.expired}</p>;
  const duration = formatDuration(attachment.duration_ms);
  return (
    <div className="attachment attachment-audio">
      {duration !== null && <span className="attachment-duration">{duration}</span>}
      {failed ? (
        <div className="attachment-failed" role="status">
          <span>{ATTACHMENT_COPY.playbackFailed}</span>
          <button
            type="button"
            className="msg-action"
            onClick={() => {
              setFailed(false);
              setAttempt((n) => n + 1);
            }}
          >
            {ATTACHMENT_COPY.retry}
          </button>
        </div>
      ) : (
        // key로 다시 마운트해 같은 src를 새로 요청한다(다시 시도 1회 = 요청 1회).
        <audio key={attempt} className="attachment-audio-player" controls preload="none" src={attachmentUrl(attachment.id)} onError={() => setFailed(true)} />
      )}
    </div>
  );
}
