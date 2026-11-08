import { useRef, useState } from 'react';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MIMES,
  ATTACHMENTS_PER_MESSAGE_MAX,
  type AttachmentView,
} from '../../../../../../packages/shared/src/index.js';
import type { ActionResult } from '../../../data/index.js';
import { ATTACHMENT_COPY } from '../../../ui/copy.js';

/** 업로드 함수(호출자가 대화 ID를 묶어 넘긴다). */
export type UploadFn = (file: File) => Promise<ActionResult<AttachmentView>>;

/** Composer 업로드는 이미지 3종만(Jarvis ★: mp3 업로드 UI는 범위 밖, 수신 표시만). 목록은 shared 상수에서 거른다. */
export const COMPOSER_IMAGE_MIMES: readonly string[] = ATTACHMENT_MIMES.filter((m) => m.startsWith('image/'));
export const COMPOSER_ACCEPT = COMPOSER_IMAGE_MIMES.join(',');

export interface ComposerChip {
  readonly key: number;
  readonly file: File;
  readonly status: 'uploading' | 'done' | 'failed';
  readonly attachmentId?: string;
  readonly error?: string;
}

/** 실패 응답 → 문구. 413·415만 전용 문구, 나머지(네트워크 포함)는 공통 문구. */
export function uploadErrorText(status: number | 'network'): string {
  if (status === 413) return ATTACHMENT_COPY.tooLarge;
  if (status === 415) return ATTACHMENT_COPY.unsupported;
  return ATTACHMENT_COPY.uploadFailed;
}

/** 업로드 전 판정(서버가 최종 판정 — 같은 문구로 바이트 전송을 아낀다). */
function precheck(file: File): string | null {
  if (file.size > ATTACHMENT_MAX_BYTES) return ATTACHMENT_COPY.tooLarge;
  if (!COMPOSER_IMAGE_MIMES.includes(file.type)) return ATTACHMENT_COPY.unsupported;
  return null;
}

/**
 * 작성기 첨부 상태(메모리 전용 — File·ID를 지속 저장소에 넣지 않는다, B7).
 * 전송 가능한 ID는 `done` 칩뿐이고, 업로드 중·실패 칩이 하나라도 있으면 `blocked`(전송 비활성).
 */
export function useComposerAttachments(upload: UploadFn | undefined) {
  const [chips, setChips] = useState<readonly ComposerChip[]>([]);
  const seq = useRef(0);
  /** 제거·전송으로 사라진 칩의 늦은 응답을 버리기 위한 현재 키 집합. */
  const live = useRef(new Set<number>());

  const patch = (key: number, next: Partial<ComposerChip>) => {
    if (!live.current.has(key)) return;
    setChips((list) => list.map((c) => (c.key === key ? { ...c, ...next } : c)));
  };

  const start = (key: number, file: File) => {
    if (upload === undefined) return;
    const pre = precheck(file);
    if (pre !== null) {
      patch(key, { status: 'failed', error: pre });
      return;
    }
    patch(key, { status: 'uploading' });
    upload(file).then(
      (r) => patch(key, r.ok ? { status: 'done', attachmentId: r.value.id } : { status: 'failed', error: uploadErrorText(r.status) }),
      () => patch(key, { status: 'failed', error: ATTACHMENT_COPY.uploadFailed }),
    );
  };

  const add = (files: readonly File[]) => {
    const room = ATTACHMENTS_PER_MESSAGE_MAX - chips.length;
    const picked = files.slice(0, Math.max(0, room)).map((file) => {
      seq.current += 1;
      return { key: seq.current, file, status: 'uploading' as const };
    });
    if (picked.length === 0) return;
    picked.forEach((c) => live.current.add(c.key));
    setChips((list) => [...list, ...picked]);
    picked.forEach((c) => start(c.key, c.file));
  };

  const remove = (key: number) => {
    live.current.delete(key);
    setChips((list) => list.filter((c) => c.key !== key));
  };

  const retry = (key: number) => {
    const chip = chips.find((c) => c.key === key);
    if (chip !== undefined) start(key, chip.file);
  };

  const clear = () => {
    live.current = new Set();
    setChips([]);
  };

  const ids = chips.flatMap((c) => (c.status === 'done' && c.attachmentId !== undefined ? [c.attachmentId] : []));
  const uploading = chips.some((c) => c.status === 'uploading');
  const blocked = uploading || chips.some((c) => c.status === 'failed');
  const full = chips.length >= ATTACHMENTS_PER_MESSAGE_MAX;
  return { chips, ids, uploading, blocked, full, add, remove, retry, clear };
}

/** 표시용 크기(KB·MB, 소수 1자리). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
