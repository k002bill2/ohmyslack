import type { AttachmentView } from '../../../../../packages/shared/src/index.js';

let n = 0;
/** 테스트용 첨부 projection(서버 `AttachmentView` 모양 그대로). */
export function attachment(over: Partial<AttachmentView> = {}): AttachmentView {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    mime: 'audio/mpeg',
    byte_size: 1234,
    expires_at: '2026-12-08T00:00:00.000Z',
    expired: false,
    ...over,
  };
}
