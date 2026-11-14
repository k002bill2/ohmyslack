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
 * 작성기 첨부 초안 저장소 — 글 초안(`DraftStore`)과 같은 소유자·같은 키(대화 id)로 작성기보다 오래 산다.
 * 메모리 전용(File·ID를 지속 저장소에 넣지 않는다, B7). 폭 구간 전환으로 작성기가 다시 마운트돼도 칩과 진행 중 업로드가 이어진다.
 * 업로드 결과는 저장소에 반영하고 구독자에게 알린다 — 언마운트된 작성기에 setState하지 않는다.
 */
export interface AttachmentDraftStore {
  readonly subscribe: (listener: () => void) => () => void;
  /** 없으면 고정된 빈 배열(같은 참조). */
  readonly chips: (key: string) => readonly ComposerChip[];
  readonly add: (key: string, files: readonly File[], upload: UploadFn | undefined) => void;
  readonly remove: (key: string, chipKey: number) => void;
  readonly retry: (key: string, chipKey: number, upload: UploadFn | undefined) => void;
  /** 전송 뒤 비우기 — 남은 요청은 모두 업로드 완료 칩이라 abort할 것이 없고, 손잡이만 정리한다. */
  readonly clear: (key: string) => void;
  /** 대상 폐기(대화 전환): 진행 중 요청을 끊고 항목을 지운다. */
  readonly discard: (key: string) => void;
  /** 전부 폐기(로그아웃·401로 셸이 내려갈 때): 진행 중 요청을 모두 끊는다. 이후에도 다시 쓸 수 있다. */
  readonly discardAll: () => void;
}

interface Waiting {
  readonly key: number;
  readonly file: File;
  readonly kind: ComposerFileKind;
}

interface Entry {
  chips: readonly ComposerChip[];
  seq: number;
  /** 제거·전송으로 사라진 칩의 늦은 응답을 버리기 위한 현재 키 집합. */
  live: Set<number>;
  /** 진행 중 요청의 취소 손잡이(칩 키별). */
  controllers: Map<number, AbortController>;
  /** 동시 업로드 상한(사람 2건, TRD §6-1-1 (2) — 초과는 서버 429)을 넘는 칩은 「업로드 중」으로 두고 차례를 기다린다. */
  waiting: readonly Waiting[];
  /** 가장 최근 작성기가 넘긴 업로드 함수 — 다시 마운트된 뒤에도 대기열을 이어 시작한다. */
  upload: UploadFn | undefined;
}

const EMPTY: readonly ComposerChip[] = Object.freeze([]);

export function createAttachmentDraftStore(): AttachmentDraftStore {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  const entryFor = (key: string): Entry => {
    const found = entries.get(key);
    if (found !== undefined) return found;
    const created: Entry = { chips: EMPTY, seq: 0, live: new Set(), controllers: new Map(), waiting: [], upload: undefined };
    entries.set(key, created);
    return created;
  };

  /** 항목이 폐기됐거나 칩이 사라졌으면 버린다. */
  const patch = (entry: Entry, chipKey: number, next: Partial<ComposerChip>) => {
    if (!entry.live.has(chipKey)) return;
    entry.chips = entry.chips.map((c) => (c.key === chipKey ? { ...c, ...next } : c));
    notify();
  };

  const abortAll = (entry: Entry) => {
    entry.controllers.forEach((c) => c.abort());
    entry.controllers = new Map();
    entry.waiting = [];
    entry.live = new Set();
  };

  const pump = (entry: Entry) => {
    while (entry.controllers.size < ATTACHMENT_HUMAN_CONCURRENT_UPLOADS && entry.waiting.length > 0) {
      const [next, ...rest] = entry.waiting;
      entry.waiting = rest;
      if (next !== undefined && entry.live.has(next.key)) begin(entry, next);
    }
  };

  const abort = (entry: Entry, chipKey: number) => {
    entry.waiting = entry.waiting.filter((w) => w.key !== chipKey);
    entry.controllers.get(chipKey)?.abort();
    entry.controllers.delete(chipKey);
  };

  const begin = (entry: Entry, { key, file, kind }: Waiting) => {
    const upload = entry.upload;
    if (upload === undefined) return;
    const controller = new AbortController();
    entry.controllers.set(key, controller);
    const options: UploadOptions =
      kind === 'document' ? { filename: file.name, type: DOCUMENT_DECLARED_TYPE, signal: controller.signal } : { signal: controller.signal };
    const settle = (next: Partial<ComposerChip>) => {
      if (entry.controllers.get(key) === controller) entry.controllers.delete(key);
      patch(entry, key, next);
      pump(entry);
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

  const start = (entry: Entry, chipKey: number, file: File, kind: ComposerFileKind | null) => {
    if (entry.upload === undefined) return;
    const pre = precheck(file, kind);
    if (pre !== null || kind === null) {
      patch(entry, chipKey, { status: 'failed', error: pre ?? ATTACHMENT_COPY.unsupported, retryable: false });
      return;
    }
    patch(entry, chipKey, { status: 'uploading' });
    abort(entry, chipKey);
    entry.waiting = [...entry.waiting, { key: chipKey, file, kind }];
    pump(entry);
  };

  return Object.freeze({
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    chips: (key: string) => entries.get(key)?.chips ?? EMPTY,
    add: (key: string, files: readonly File[], upload: UploadFn | undefined) => {
      const entry = entryFor(key);
      entry.upload = upload;
      const room = ATTACHMENTS_PER_MESSAGE_MAX - entry.chips.length;
      const picked = files.slice(0, Math.max(0, room)).map((file) => {
        entry.seq += 1;
        return { key: entry.seq, file, status: 'uploading' as const, kind: composerFileKind(file.name) };
      });
      if (picked.length === 0) return;
      picked.forEach((c) => entry.live.add(c.key));
      entry.chips = [...entry.chips, ...picked];
      notify();
      picked.forEach((c) => start(entry, c.key, c.file, c.kind));
    },
    remove: (key: string, chipKey: number) => {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entry.live.delete(chipKey);
      abort(entry, chipKey);
      entry.chips = entry.chips.filter((c) => c.key !== chipKey);
      notify();
      pump(entry);
    },
    retry: (key: string, chipKey: number, upload: UploadFn | undefined) => {
      const entry = entries.get(key);
      const chip = entry?.chips.find((c) => c.key === chipKey);
      if (entry === undefined || chip === undefined) return;
      entry.upload = upload;
      start(entry, chipKey, chip.file, chip.kind);
    },
    clear: (key: string) => {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entry.live = new Set();
      entry.controllers = new Map();
      entry.waiting = [];
      entry.chips = EMPTY;
      notify();
    },
    discard: (key: string) => {
      const entry = entries.get(key);
      if (entry === undefined) return;
      abortAll(entry);
      entries.delete(key);
      notify();
    },
    discardAll: () => {
      entries.forEach(abortAll);
      entries.clear();
      notify();
    },
  });
}
