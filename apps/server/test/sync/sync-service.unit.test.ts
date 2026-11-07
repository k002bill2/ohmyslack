import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/http/errors.js';
import { createReadEvents, type ReadUpdated } from '../../src/modules/sync/events.js';
import { createSyncService } from '../../src/modules/sync/service.js';
import type { ReadMergeResult, ReadTarget, ScanRequest, SnapshotPage, SyncStore } from '../../src/modules/sync/store.js';
import { SNAPSHOT_LIMIT_MAX, SYNC_LIMIT_MAX } from '../../src/shared.js';

/** sync 서비스의 cursor 판정·기본 limit·읽음 이벤트 시점(가짜 저장소). 실제 스캔·병합 SQL은 int 테스트가 본다. */
const NOW = 1_700_000_000_000;

interface Fake {
  watermark: number;
  floor: number;
  scannedThrough: number | undefined;
  merge: ReadMergeResult;
  readonly scans: ScanRequest[];
  readonly snapshots: [string, number | undefined, number][];
  readonly merges: ReadTarget[];
  readonly floors: Date[];
}

function setup() {
  const fake: Fake = {
    watermark: 100,
    floor: 10,
    scannedThrough: undefined,
    merge: { ok: true, lastReadSeq: 9, updatedAt: new Date(NOW - 1) },
    scans: [],
    snapshots: [],
    merges: [],
    floors: [],
  };
  const page: SnapshotPage = { messages: [], hasMore: true };
  const store: SyncStore = {
    async watermark() {
      return fake.watermark;
    },
    async retentionFloor(now) {
      fake.floors.push(now);
      return fake.floor;
    },
    async scan(r) {
      fake.scans.push(r);
      return { scannedThrough: fake.scannedThrough ?? r.through, changes: [] };
    },
    async snapshot(c, before, limit) {
      fake.snapshots.push([c, before, limit]);
      return page;
    },
    async mergeRead(t) {
      fake.merges.push(t);
      return fake.merge;
    },
  };
  const events = createReadEvents();
  const emitted: ReadUpdated[] = [];
  events.onUpdated((e) => emitted.push(e));
  const service = createSyncService({ store, events, clock: () => NOW });
  return { fake, service, emitted, page };
}

async function httpError(p: Promise<unknown>): Promise<{ statusCode: number; code: string }> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  const { statusCode, code } = err as HttpError;
  return { statusCode, code };
}

describe('sync', () => {
  it('through가 없으면 현재 watermark로 확정하고 기본 limit으로 스캔한다', async () => {
    const { fake, service } = setup();
    const page = await service.sync('u1', 20, undefined, undefined);
    expect(fake.scans).toEqual([{ userId: 'u1', after: 20, through: 100, limit: SYNC_LIMIT_MAX }]);
    expect(page).toEqual({ scannedThrough: 100, changes: [], throughCursor: 100, hasMore: false });
    expect(fake.floors).toEqual([new Date(NOW)]);
  });

  it('후속 페이지는 받은 through를 그대로 쓰고, 덜 스캔했으면 hasMore', async () => {
    const { fake, service } = setup();
    fake.scannedThrough = 60;
    const page = await service.sync('u1', 50, 80, 5);
    expect(fake.scans).toEqual([{ userId: 'u1', after: 50, through: 80, limit: 5 }]);
    expect(page).toMatchObject({ scannedThrough: 60, throughCursor: 80, hasMore: true });
  });

  it('through > watermark, after > through는 400이고 스캔하지 않는다', async () => {
    const { fake, service } = setup();
    expect(await httpError(service.sync('u1', 20, 101, undefined))).toEqual({ statusCode: 400, code: 'invalid_request' });
    expect(await httpError(service.sync('u1', 81, 80, undefined))).toEqual({ statusCode: 400, code: 'invalid_request' });
    expect(fake.scans).toEqual([]);
  });

  it('보존 경계보다 작은 after는 410 cursor_expired, 경계와 같으면 허용', async () => {
    const { fake, service } = setup();
    expect(await httpError(service.sync('u1', 9, undefined, undefined))).toEqual({ statusCode: 410, code: 'cursor_expired' });
    expect(fake.scans).toEqual([]);
    await service.sync('u1', 10, undefined, undefined);
    expect(fake.scans).toHaveLength(1);
  });
});

describe('snapshot', () => {
  it('snapshot cursor는 조회 전 watermark이고 기본 limit을 쓴다', async () => {
    const { fake, service, page } = setup();
    const res = await service.snapshot('c1', undefined, undefined);
    expect(res).toEqual({ ...page, snapshotCursor: 100 });
    await service.snapshot('c1', 7, 3);
    expect(fake.snapshots).toEqual([
      ['c1', undefined, SNAPSHOT_LIMIT_MAX],
      ['c1', 7, 3],
    ]);
  });
});

describe('markRead', () => {
  it('병합된 값을 돌려주고 그 값으로 이벤트를 한 번 발행한다', async () => {
    const { fake, service, emitted } = setup();
    const out = await service.markRead('u1', { conversationId: 'c1', threadRootId: 'r1', lastReadSeq: 5 });
    expect(fake.merges).toEqual([{ userId: 'u1', conversationId: 'c1', threadRootId: 'r1', lastReadSeq: 5, at: new Date(NOW) }]);
    // 요청값 5보다 큰 기존 값 9가 이긴다(max 병합).
    expect(out).toEqual({ conversationId: 'c1', threadRootId: 'r1', lastReadSeq: 9, updatedAt: new Date(NOW - 1) });
    expect(emitted).toEqual([{ userId: 'u1', ...out }]);
  });

  it('범위 밖 위치는 400이고 이벤트를 발행하지 않는다', async () => {
    const { fake, service, emitted } = setup();
    fake.merge = { ok: false };
    expect(await httpError(service.markRead('u1', { conversationId: 'c1', threadRootId: null, lastReadSeq: 99 }))).toEqual({
      statusCode: 400,
      code: 'invalid_request',
    });
    expect(emitted).toEqual([]);
  });
});
