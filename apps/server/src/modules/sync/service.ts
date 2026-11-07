import { HttpError } from '../../http/errors.js';
import { SNAPSHOT_LIMIT_MAX, SYNC_LIMIT_MAX } from '../../shared.js';
import type { ReadEvents } from './events.js';
import type { ScanResult, SnapshotPage, SyncStore } from './store.js';

export interface SyncServiceDeps {
  readonly store: SyncStore;
  readonly events: ReadEvents;
  readonly clock: () => number;
}

export interface SyncPage extends ScanResult {
  readonly throughCursor: number;
  readonly hasMore: boolean;
}

export interface SnapshotResult extends SnapshotPage {
  readonly snapshotCursor: number;
}

export interface ReadInput {
  readonly conversationId: string;
  readonly threadRootId: string | null;
  readonly lastReadSeq: number;
}

export interface ReadOutcome extends ReadInput {
  readonly updatedAt: Date;
}

export interface SyncService {
  sync(userId: string, after: number, through: number | undefined, limit: number | undefined): Promise<SyncPage>;
  /** 대화 접근은 라우트 가드(assertAccess)가 먼저 판정한다. */
  snapshot(conversationId: string, beforeSeq: number | undefined, limit: number | undefined): Promise<SnapshotResult>;
  /** 대화 접근은 라우트 가드(assertAccess)가 먼저 판정한다. 범위 밖 위치는 400. */
  markRead(userId: string, input: ReadInput): Promise<ReadOutcome>;
}

const invalid = (): HttpError => new HttpError(400, 'invalid_request');

/** 읽음 이벤트는 store가 commit하고 돌아온 **뒤**에만 발행한다(B3). */
export function createSyncService(deps: SyncServiceDeps): SyncService {
  const { store, events, clock } = deps;

  return {
    async sync(userId, after, through, limit) {
      const current = await store.watermark();
      // 첫 페이지는 요청 시작 시점의 마지막 commit cursor를 watermark로 확정하고, 후속 페이지는 받은 값을 그대로 쓴다.
      const throughCursor = through ?? current;
      if (throughCursor > current || after > throughCursor) throw invalid();
      if (after < (await store.retentionFloor(new Date(clock())))) throw new HttpError(410, 'cursor_expired');
      const scan = await store.scan({ userId, after, through: throughCursor, limit: limit ?? SYNC_LIMIT_MAX });
      return { ...scan, throughCursor, hasMore: scan.scannedThrough < throughCursor };
    },
    async snapshot(conversationId, beforeSeq, limit) {
      const snapshotCursor = await store.watermark();
      const page = await store.snapshot(conversationId, beforeSeq, limit ?? SNAPSHOT_LIMIT_MAX);
      return { ...page, snapshotCursor };
    },
    async markRead(userId, input) {
      const merged = await store.mergeRead({ ...input, userId, at: new Date(clock()) });
      if (!merged.ok) throw invalid();
      const outcome = { ...input, lastReadSeq: merged.lastReadSeq, updatedAt: merged.updatedAt };
      events.updated({ userId, ...outcome });
      return outcome;
    },
  };
}
