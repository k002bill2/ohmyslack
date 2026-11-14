import { useState, useSyncExternalStore } from 'react';
import { ATTACHMENTS_PER_MESSAGE_MAX } from '../../../../../../packages/shared/src/index.js';
import { ATTACHMENT_COPY } from '../../../ui/copy.js';
import { createAttachmentDraftStore, type AttachmentDraftStore, type UploadFn } from './attachment-drafts.js';

export {
  createAttachmentDraftStore,
  uploadErrorText,
  type AttachmentDraftStore,
  type ComposerChip,
  type UploadFn,
  type UploadOptions,
} from './attachment-drafts.js';

/** 작성기에 주입하는 첨부 초안(소유자의 저장소 + 대상 키). */
export interface AttachmentDraft {
  readonly store: AttachmentDraftStore;
  readonly key: string;
}

const LOCAL_KEY = 'local';

/**
 * 작성기 첨부 상태(메모리 전용 — File·ID를 지속 저장소에 넣지 않는다, B7).
 * `draft`가 있으면 소유자의 저장소를 써서 작성기가 다시 마운트돼도 칩·진행 중 업로드가 이어진다. 없으면 훅 인스턴스 전용 저장소.
 * 전송 가능한 ID는 `done` 칩뿐이고, 업로드 중·실패 칩이 하나라도 있으면 `blocked`(전송 비활성).
 */
export function useComposerAttachments(upload: UploadFn | undefined, draft?: AttachmentDraft) {
  const [own] = useState(createAttachmentDraftStore);
  const store = draft?.store ?? own;
  const key = draft?.key ?? LOCAL_KEY;
  const chips = useSyncExternalStore(store.subscribe, () => store.chips(key), () => store.chips(key));

  const add = (files: readonly File[]) => store.add(key, files, upload);
  const remove = (chipKey: number) => store.remove(key, chipKey);
  const retry = (chipKey: number) => store.retry(key, chipKey, upload);
  const clear = () => store.clear(key);

  const ids = chips.flatMap((c) => (c.status === 'done' && c.attachmentId !== undefined ? [c.attachmentId] : []));
  const uploading = chips.some((c) => c.status === 'uploading');
  const blocked = uploading || chips.some((c) => c.status === 'failed');
  const full = chips.length >= ATTACHMENTS_PER_MESSAGE_MAX;
  /** 본문이 빌 때 채울 자리 문구(G-58): 완료 첨부 중 첫 첨부의 계열. */
  const firstDone = chips.find((c) => c.status === 'done');
  const placeholderBody = firstDone?.kind === 'document' ? ATTACHMENT_COPY.documentOnlyBody : ATTACHMENT_COPY.imageOnlyBody;
  return { chips, ids, uploading, blocked, full, placeholderBody, add, remove, retry, clear };
}

/** 표시용 크기(KB·MB, 소수 1자리). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
