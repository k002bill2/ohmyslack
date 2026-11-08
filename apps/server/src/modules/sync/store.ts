import type { SyncChangeOp } from '../../shared.js';
import type { MessageRecord } from '../messages/index.js';

/** sync·읽음 저장소 경계. 운영은 `repo.ts`(pg). */
export interface ScanRequest {
  readonly userId: string;
  readonly after: number;
  readonly through: number;
  readonly limit: number;
}

export interface FoldedChange {
  /** 페이지 안에서 이 메시지의 최신 change_id. */
  readonly changeId: number;
  /** 이 메시지 자신의 페이지 내 최신 변경 종류. 답글 변경으로만 실린 원문은 'edit'. */
  readonly op: SyncChangeOp;
  readonly message: MessageRecord;
}

export interface ScanResult {
  /** 실제로 스캔한 마지막 change_id(스캔 행이 limit 미만이면 through). */
  readonly scannedThrough: number;
  readonly changes: readonly FoldedChange[];
}

export interface SnapshotPage {
  readonly messages: readonly MessageRecord[];
  readonly hasMore: boolean;
}

export interface ReadTarget {
  readonly userId: string;
  readonly conversationId: string;
  readonly threadRootId: string | null;
  readonly lastReadSeq: number;
  readonly at: Date;
}

export type ReadMergeResult =
  | { readonly ok: true; readonly lastReadSeq: number; readonly updatedAt: Date }
  | { readonly ok: false };

export interface SyncStore {
  /** 마지막으로 commit된 전역 change_id(sync_clock). */
  watermark(): Promise<number>;
  /** 보존 경계: 이 값보다 작은 cursor는 만료(410). 30일·100,000 row 중 먼저 도달한 경계(TRD §5). */
  retentionFloor(now: Date): Promise<number>;
  /** (after, through] 구간을 최대 limit row 스캔하고, 현재 멤버인 대화의 변경만 message id로 접어 현재 상태로 돌려준다. */
  scan(request: ScanRequest): Promise<ScanResult>;
  /** 대화의 현재 메시지 상태(원문·답글, seq 내림차순 limit개를 오름차순으로). */
  snapshot(conversationId: string, beforeSeq: number | undefined, limit: number): Promise<SnapshotPage>;
  /** 위치 검사(대화·root·최대 seq) 후 max(current, request) 병합. 범위 밖이면 ok:false. */
  mergeRead(target: ReadTarget): Promise<ReadMergeResult>;
}
