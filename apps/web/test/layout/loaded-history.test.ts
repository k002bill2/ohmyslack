/** Codex r2 P2(W-11d L48b): 구분선 위치는 이력 조회 완료 뒤 고정 — DataSource가 완료 신호(Snapshot.loadedHistory)를 낸다. */
import { describe, expect, it } from 'vitest';
import { writeCheckpoint } from '../../src/features/sync';
import { CONV, ME, U, flush, message, setup } from '../sync/fake-server.js';

describe('Snapshot.loadedHistory', () => {
  it('open 직후 null → 이력 응답 뒤 그 대화 id → 다른 대화를 열면 다시 null', async () => {
    const { server, ds, storage } = setup();
    const OTHER = U(11);
    writeCheckpoint(ME, 5, storage);
    server.on(`GET /api/conversations/${CONV}/messages`, () => ({ status: 200, body: { messages: [message(1)], has_more: false } }));
    expect(ds.getSnapshot().loadedHistory).toBeNull();
    ds.open?.(CONV);
    expect(ds.getSnapshot().loadedHistory).toBeNull();
    for (let i = 0; i < 3; i += 1) await flush();
    expect(ds.getSnapshot().loadedHistory).toBe(CONV);
    ds.open?.(OTHER);
    expect(ds.getSnapshot().loadedHistory).not.toBe(OTHER);
  });

  it('이력 조회가 실패해도 끝남으로 알린다(가진 원문으로 계산)', async () => {
    const { server, ds, storage } = setup();
    writeCheckpoint(ME, 5, storage);
    server.on(`GET /api/conversations/${CONV}/messages`, () => 'network');
    ds.open?.(CONV);
    for (let i = 0; i < 3; i += 1) await flush();
    expect(ds.getSnapshot().loadedHistory).toBe(CONV);
  });
});
