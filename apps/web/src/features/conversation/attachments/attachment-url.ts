import type { AttachmentView } from '../../../../../../packages/shared/src/index.js';

/** 다운로드 경로(TRD §3 `GET /api/attachments/{id}`). `<audio>`·`<img>` src로 직접 쓴다 — 바이트를 JS로 받아 저장하지 않는다(B7). */
export function attachmentUrl(id: string): string {
  return `/api/attachments/${encodeURIComponent(id)}`;
}

export function isAudio(attachment: AttachmentView): boolean {
  return attachment.mime.startsWith('audio/');
}

/** `duration_ms` → m:ss(없거나 음수면 null). */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
