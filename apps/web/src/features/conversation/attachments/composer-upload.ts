import { useRef, useState } from 'react';
import { ATTACHMENT_HUMAN_CONCURRENT_UPLOADS, ATTACHMENTS_PER_MESSAGE_MAX, type AttachmentView } from '../../../../../../packages/shared/src/index.js';
import type { ActionFailure, ActionResult } from '../../../data/index.js';
import { ATTACHMENT_COPY } from '../../../ui/copy.js';
import { failureText } from '../../spaces/index.js';
import { composerFileKind, maxBytesFor, type ComposerFileKind } from './file-kinds.js';

/** 업로드 옵션: 문서·텍스트는 원 파일명 헤더와 `application/octet-stream`(서버가 내용·확장자로 판정, TRD §6-1-1). */
export interface UploadOptions {
  readonly filename?: string;
  readonly type?: string;
  readonly signal?: AbortSignal;
}

/** 업로드 함수(호출자가 대화 ID를 묶어 넘긴다). `signal`로 「첨부 제거」가 요청을 끊는다(UI_STATES §2-13). */
export type UploadFn = (file: File, options?: UploadOptions) => Promise<ActionResult<AttachmentView>>;

/** 문서 선언 형식 — 브라우저의 `File.type`은 hwp·md 등에서 비거나 매크로형과 어긋나므로 쓰지 않는다(서버가 이 값을 판정 생략으로 받는다). */
const DOCUMENT_DECLARED_TYPE = 'application/octet-stream';

export interface ComposerChip {
  readonly key: number;
  readonly file: File;
  readonly status: 'uploading' | 'done' | 'failed';
  /** 확장자로 고른 계열(허용 밖이면 null — 사전 거부). */
  readonly kind: ComposerFileKind | null;
  readonly attachmentId?: string;
  readonly error?: string;
  /** 같은 파일을 다시 보내도 결과가 같은 실패(413·415·사전 판정)면 false — 「다시 시도」 없이 제거만. */
  readonly retryable?: boolean;
}

/**
 * 실패 응답 → 문구(G-54–G-57). 413은 계열별 상한 문구(형식 모르면 문서 문구), 415는 하위 코드 `macro_extension_mismatch`만 G-56이고
 * 나머지 코드·코드 없음·모르는 코드는 G-54. 그 외는 「업로드하지 못했습니다.」 + 원인 1문장.
 */
export function uploadErrorText(failure: ActionFailure, kind: ComposerFileKind | null = null): string {
  if (failure.status === 413) return kind === 'image' ? ATTACHMENT_COPY.tooLarge : ATTACHMENT_COPY.docTooLarge;
  if (failure.status === 415) return 'code' in failure && failure.code === 'macro_extension_mismatch' ? ATTACHMENT_COPY.macroExtension : ATTACHMENT_COPY.unsupported;
  return `${ATTACHMENT_COPY.uploadFailed} ${failureText(failure)}`;
}

/** 업로드 전 판정(서버가 최종 판정 — 같은 문구로 바이트 전송을 아낀다). 확장자 허용 목록 밖 → G-54, 계열별 상한 초과 → G-55. */
function precheck(file: File, kind: ComposerFileKind | null): string | null {
  if (kind === null) return ATTACHMENT_COPY.unsupported;
  if (file.size > maxBytesFor(kind)) return kind === 'image' ? ATTACHMENT_COPY.tooLarge : ATTACHMENT_COPY.docTooLarge;
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

  /** 진행 중 요청의 취소 손잡이(칩 키별). 제거·전송 비우기 때 abort한다. */
  const controllers = useRef(new Map<number, AbortController>());

  /** 동시 업로드 상한(사람 2건, TRD §6-1-1 (2) — 초과는 서버 429)을 넘는 칩은 「업로드 중」으로 두고 차례를 기다린다. */
  const waiting = useRef<readonly { readonly key: number; readonly file: File; readonly kind: ComposerFileKind }[]>([]);

  const pump = () => {
    while (controllers.current.size < ATTACHMENT_HUMAN_CONCURRENT_UPLOADS && waiting.current.length > 0) {
      const [next, ...rest] = waiting.current;
      waiting.current = rest;
      if (next !== undefined && live.current.has(next.key)) begin(next.key, next.file, next.kind);
    }
  };

  const abort = (key: number) => {
    waiting.current = waiting.current.filter((w) => w.key !== key);
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
  };

  const begin = (key: number, file: File, kind: ComposerFileKind) => {
    if (upload === undefined) return;
    const controller = new AbortController();
    controllers.current.set(key, controller);
    const options: UploadOptions =
      kind === 'document' ? { filename: file.name, type: DOCUMENT_DECLARED_TYPE, signal: controller.signal } : { signal: controller.signal };
    const settle = (next: Partial<ComposerChip>) => {
      if (controllers.current.get(key) === controller) controllers.current.delete(key);
      patch(key, next);
      pump();
    };
    upload(file, options).then(
      (r) =>
        settle(
          r.ok
            ? { status: 'done', attachmentId: r.value.id }
            : { status: 'failed', error: uploadErrorText(r, kind), retryable: r.status !== 413 && r.status !== 415 },
        ),
      () => settle({ status: 'failed', error: uploadErrorText({ status: 'network' }, kind), retryable: true }),
    );
  };

  const start = (key: number, file: File, kind: ComposerFileKind | null) => {
    if (upload === undefined) return;
    const pre = precheck(file, kind);
    if (pre !== null || kind === null) {
      patch(key, { status: 'failed', error: pre ?? ATTACHMENT_COPY.unsupported, retryable: false });
      return;
    }
    patch(key, { status: 'uploading' });
    abort(key);
    waiting.current = [...waiting.current, { key, file, kind }];
    pump();
  };

  const add = (files: readonly File[]) => {
    const room = ATTACHMENTS_PER_MESSAGE_MAX - chips.length;
    const picked = files.slice(0, Math.max(0, room)).map((file) => {
      seq.current += 1;
      return { key: seq.current, file, status: 'uploading' as const, kind: composerFileKind(file.name) };
    });
    if (picked.length === 0) return;
    picked.forEach((c) => live.current.add(c.key));
    setChips((list) => [...list, ...picked]);
    picked.forEach((c) => start(c.key, c.file, c.kind));
  };

  const remove = (key: number) => {
    live.current.delete(key);
    abort(key);
    setChips((list) => list.filter((c) => c.key !== key));
    pump();
  };

  const retry = (key: number) => {
    const chip = chips.find((c) => c.key === key);
    if (chip !== undefined) start(key, chip.file, chip.kind);
  };

  /** 전송 뒤 비우기 — 남은 요청은 모두 업로드 완료 칩이라 abort할 것이 없지만, 남은 손잡이는 정리한다. */
  const clear = () => {
    live.current = new Set();
    controllers.current = new Map();
    waiting.current = [];
    setChips([]);
  };

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
