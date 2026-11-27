/** 운영 write 응답 런타임 검증: 계약 위반 2xx는 실패로 단정하지 않고 「저장 여부 확인 중」 → sync로 수렴한다. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeCheckpoint } from '../../src/features/sync';
import { CONV, ME, U, flush, message, setup } from './fake-server.js';

const SECRET = '비밀본문-계약위반';
const omit = (o: object, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
const syncWith = (changeId: number, m: unknown) => ({
  status: 200,
  body: { changes: [{ change_id: changeId, message: m }], through_cursor: changeId, scanned_through: changeId, has_more: false, next_cursor: changeId },
});

afterEach(() => vi.restoreAllMocks());

describe('write 응답 런타임 parse', () => {
  it('send 2xx가 계약 위반이면 「확인 중」(unknown)으로 두고 sync에 같은 client_message_id가 오면 확정한다', async () => {
    const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'log')];
    const { server, ds, storage } = setup({ newClientMessageId: () => U(900) });
    server.allowWriteContractViolation = true;
    writeCheckpoint(ME, 0, storage);
    const mine = message(7, { author_id: ME, client_message_id: U(900), body: SECRET });
    server.on(`POST /api/conversations/${CONV}/messages`, () => ({ status: 201, body: { message: mine, seq: 7, mention_user_ids: [] } }));
    ds.open?.(CONV);
    await ds.resume();
    ds.send({ conversationId: CONV }, SECRET);
    for (let i = 0; i < 3; i += 1) await flush();
    const pending = ds.getSnapshot().messages.filter((m) => m.body === SECRET);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.pending?.status).toBe('unknown');
    server.on('GET /api/sync', () => syncWith(20, mine));
    expect(await ds.resume()).toBe(true);
    const after = ds.getSnapshot().messages.filter((m) => m.body === SECRET);
    expect(after).toHaveLength(1);
    expect(after[0]?.pending).toBeUndefined();
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
  });

  it('정상 send 응답은 그대로 확정된다(회귀 없음)', async () => {
    const { server, ds, storage } = setup({ newClientMessageId: () => U(901) });
    writeCheckpoint(ME, 0, storage);
    const mine = message(8, { author_id: ME, client_message_id: U(901), body: 'ok' });
    server.on(`POST /api/conversations/${CONV}/messages`, () => ({ status: 201, body: { message: mine, seq: 8, change_id: 21, mention_user_ids: [] } }));
    ds.open?.(CONV);
    await ds.resume();
    ds.send({ conversationId: CONV }, 'ok');
    for (let i = 0; i < 3; i += 1) await flush();
    const shown = ds.getSnapshot().messages.filter((m) => m.body === 'ok');
    expect(shown).toHaveLength(1);
    expect(shown[0]?.pending).toBeUndefined();
  });

  it('edit 2xx가 계약 위반이면 실패로 단정하지 않고(확인하지 못함) 반영하지 않으며, sync로 수렴한다', async () => {
    const { server, ds, storage } = setup();
    server.allowWriteContractViolation = true;
    writeCheckpoint(ME, 5, storage);
    const original = message(1, { author_id: ME, body: '원문' });
    const edited = { ...original, body: SECRET, edited_at: '2026-11-07T00:01:00Z' };
    server.on(`GET /api/conversations/${CONV}/messages`, () => ({ status: 200, body: { messages: [original], has_more: false } }));
    server.on(`PATCH /api/messages/${original.id}`, () => ({ status: 200, body: { message: omit(edited, 'author_kind'), seq: 1, change_id: 30, mention_user_ids: [] } }));
    ds.open?.(CONV);
    await ds.resume();
    await flush();
    const res = await ds.editMessage?.(original.id, SECRET);
    expect(res).toEqual({ ok: false, status: 'network', timedOut: true });
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(ds.getSnapshot().messages.find((m) => m.id === original.id)?.body).toBe('원문');
    server.on('GET /api/sync', () => syncWith(30, edited));
    expect(await ds.resume()).toBe(true);
    expect(ds.getSnapshot().messages.find((m) => m.id === original.id)?.body).toBe(SECRET);
  });

  it('정상 edit 응답은 그대로 반영된다(회귀 없음)', async () => {
    const { server, ds, storage } = setup();
    writeCheckpoint(ME, 5, storage);
    const original = message(1, { author_id: ME, body: '원문' });
    const edited = { ...original, body: '고침', edited_at: '2026-11-07T00:01:00Z' };
    server.on(`GET /api/conversations/${CONV}/messages`, () => ({ status: 200, body: { messages: [original], has_more: false } }));
    server.on(`PATCH /api/messages/${original.id}`, () => ({ status: 200, body: { message: edited, seq: 1, change_id: 30, mention_user_ids: [] } }));
    ds.open?.(CONV);
    await ds.resume();
    await flush();
    expect(await ds.editMessage?.(original.id, '고침')).toEqual({ ok: true, value: null });
    expect(ds.getSnapshot().messages.find((m) => m.id === original.id)?.body).toBe('고침');
  });
});
