import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_RETENTION_DAYS } from '../../src/shared.js';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { blobExists, counts, download, HTML, jpeg, mp3, png, SVG, upload, uploadedId, webp } from './att-harness.js';

/** FR-OPS-05 지정 테스트(DEV_DESIGN 6-2, 정본: TRD §6-1). */
let ctx: ConvIntContext | undefined;
let now = Date.now();
const DAY = 24 * 60 * 60 * 1000;

afterEach(async () => {
  await teardownConvInt(ctx);
  ctx = undefined;
});

function retention(c: ConvIntContext) {
  const service = c.app.domainServices?.attachments;
  if (service === undefined) throw new Error('첨부 서비스 없음');
  return service.runRetention();
}

interface MessageJson {
  readonly message: { readonly id: string; readonly attachments: { id: string; mime: string; expired: boolean; expires_at: string }[] };
}

describe('첨부(FR-OPS-05)', () => {
  it('FR-OPS-05 허용목록 밖 형식과 상한+1바이트 첨부는 저장되지 않고 내용으로 형식을 판정하며 비참여자는 404이고 Range 요청은 206이며 보존 만료·메시지 삭제 시 바이트가 지워진다', async () => {
    now = Date.now();
    ctx = await setupConvInt({ clock: () => now });
    const c = ctx;
    const a = await as(c.app, 'a');
    const b = await as(c.app, 'b');
    const outsider = await as(c.app, 'c');
    const leaver = await as(c.app, 'l');
    const channel = await createChannel(c.app, a, 'files');
    const other = await createChannel(c.app, a, 'other');
    await req(c.app, 'POST', `/api/conversations/${channel}/join`, b);
    await req(c.app, 'POST', `/api/conversations/${channel}/join`, leaver);

    // 1) 허용목록 밖·선언 불일치·위장은 415, 상한+1바이트는 413 — 모두 저장 0.
    const rejected: [Buffer, string, number][] = [
      [HTML, 'text/html', 415],
      [SVG, 'image/svg+xml', 415],
      [HTML, 'image/png', 415], // 선언만 허용 형식
      [png(), 'image/jpeg', 415], // 내용 PNG, 선언 JPEG
      [Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), HTML]), 'audio/mpeg', 415], // ID3 뒤 프레임 sync 없음
      [Buffer.from('%PDF-1.7\n'), 'application/pdf', 415],
      [png(2, 3, ATTACHMENT_MAX_BYTES + 1 - png().length), 'image/png', 413],
    ];
    for (const [bytes, type, status] of rejected) {
      const res = await upload(c.app, a, channel, bytes, type);
      expect(res.statusCode, `${type} ${bytes.length}`).toBe(status);
    }
    expect(await counts(c.schema)).toEqual({ meta: 0, blobs: 0 });

    // 2) 내용으로 형식 판정: 4형식 201, 크기·길이는 헤더에서. 상한 정확히(10 MiB)는 허용.
    const up = await upload(c.app, a, channel, png(2, 3), 'image/png; charset=binary');
    expect(up.statusCode).toBe(201);
    expect(up.json()).toMatchObject({ attachment: { mime: 'image/png', width: 2, height: 3, expired: false } });
    const pngId = up.json<{ attachment_id: string }>().attachment_id;
    expect((await upload(c.app, a, channel, jpeg(5, 4), 'image/jpeg')).json()).toMatchObject({ attachment: { mime: 'image/jpeg', width: 5, height: 4 } });
    expect((await upload(c.app, a, channel, webp(7, 6), 'image/webp')).json()).toMatchObject({ attachment: { mime: 'image/webp', width: 7, height: 6 } });
    const audio = await upload(c.app, a, channel, mp3(16_000), 'audio/mpeg');
    expect(audio.json()).toMatchObject({ attachment: { mime: 'audio/mpeg', duration_ms: 1000, width: null } });
    const audioId = audio.json<{ attachment_id: string }>().attachment_id;
    const max = await upload(c.app, a, channel, png(2, 3, ATTACHMENT_MAX_BYTES - png().length), 'image/png');
    expect(max.statusCode).toBe(201);
    const maxId = max.json<{ attachment_id: string }>().attachment_id;

    // 3) 비참여자 C·나간 사용자 L은 업로드·다운로드 404, 참여자 B는 200.
    expect((await req(c.app, 'DELETE', `/api/conversations/${channel}/membership`, leaver)).statusCode).toBe(204);
    for (const who of [outsider, leaver]) {
      expect((await download(c.app, who, pngId)).statusCode).toBe(404);
      expect((await upload(c.app, who, channel, png(), 'image/png')).statusCode).toBe(404);
    }
    expect((await download(c.app, a, randomUUID())).statusCode).toBe(404);
    const full = await download(c.app, b, pngId);
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.equals(png(2, 3))).toBe(true);

    // 4) Range: 단일 범위 206 + Content-Range, 접미 범위 206, 다중 범위는 전체 200, 범위 밖 416.
    const part = await download(c.app, b, pngId, { range: 'bytes=0-7' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-7/${png().length}`);
    expect(part.rawPayload.equals(png().subarray(0, 8))).toBe(true);
    const tail = await download(c.app, b, audioId, { range: 'bytes=-4' });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.length).toBe(4);
    expect((await download(c.app, b, pngId, { range: 'bytes=0-1,4-5' })).statusCode).toBe(200);
    const unsat = await download(c.app, b, pngId, { range: 'bytes=9999-' });
    expect(unsat.statusCode).toBe(416);
    expect(unsat.headers['content-range']).toBe(`bytes */${png().length}`);

    // 5) 결속: 남의 첨부·다른 대화 첨부·5개 초과는 400(결속·메시지 0). 자기 첨부는 결속되고 projection에 실린다.
    const bOwn = await uploadedId(c.app, b, channel, png(), 'image/png');
    const elsewhere = await uploadedId(c.app, a, other, png(), 'image/png');
    for (const ids of [[bOwn], [elsewhere], [pngId, pngId]]) {
      const bad = await req(c.app, 'POST', `/api/conversations/${channel}/messages`, a, { client_message_id: randomUUID(), body: 'x', attachment_ids: ids });
      expect(bad.statusCode, JSON.stringify(ids)).toBe(400);
    }
    const tooMany = await req(c.app, 'POST', `/api/conversations/${channel}/messages`, a, {
      client_message_id: randomUUID(),
      body: 'x',
      attachment_ids: [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    });
    expect(tooMany.statusCode).toBe(400);
    const cmid = randomUUID();
    const sent = await req(c.app, 'POST', `/api/conversations/${channel}/messages`, a, { client_message_id: cmid, body: '사진', attachment_ids: [pngId, audioId] });
    expect(sent.statusCode).toBe(201);
    const msg = sent.json<MessageJson>().message;
    expect(msg.attachments.map((x) => x.id).sort()).toEqual([pngId, audioId].sort());
    expect(msg.attachments.every((x) => x.expired === false)).toBe(true);
    // 멱등: 같은 payload 200, 첨부 집합이 다르면 409. 이미 결속된 첨부를 다른 메시지에 결속하면 400.
    const replay = await req(c.app, 'POST', `/api/conversations/${channel}/messages`, a, { client_message_id: cmid, body: '사진', attachment_ids: [audioId, pngId] });
    expect(replay.statusCode).toBe(200);
    const conflict = await req(c.app, 'POST', `/api/conversations/${channel}/messages`, a, { client_message_id: cmid, body: '사진', attachment_ids: [pngId] });
    expect(conflict.statusCode).toBe(409);
    const rebind = await req(c.app, 'POST', `/api/conversations/${channel}/messages`, a, { client_message_id: randomUUID(), body: 'y', attachment_ids: [pngId] });
    expect(rebind.statusCode).toBe(400);
    const history = (await req(c.app, 'GET', `/api/conversations/${channel}/messages`, b)).json<{ messages: MessageJson['message'][] }>();
    expect(history.messages.find((m) => m.id === msg.id)?.attachments).toHaveLength(2);
    expect(history.messages.filter((m) => m.id !== msg.id).every((m) => Array.isArray(m.attachments) && m.attachments.length === 0)).toBe(true);
    const synced = (await req(c.app, 'GET', '/api/sync?after=0', b)).json<{ changes: { message: MessageJson['message'] }[] }>();
    expect(synced.changes.find((ch) => ch.message.id === msg.id)?.message.attachments).toHaveLength(2);

    // 6) 메시지 삭제 → 바이트 즉시 삭제, 메타 유지(expired=true), 다운로드 404.
    const audioMsg = await uploadedId(c.app, a, channel, mp3(), 'audio/mpeg');
    const doomed = await req(c.app, 'POST', `/api/conversations/${channel}/messages`, a, { client_message_id: randomUUID(), body: '음성', attachment_ids: [audioMsg] });
    const doomedId = doomed.json<MessageJson>().message.id;
    expect(await blobExists(c.schema, audioMsg)).toBe(true);
    expect((await req(c.app, 'DELETE', `/api/messages/${doomedId}`, a)).statusCode).toBe(200);
    expect(await blobExists(c.schema, audioMsg)).toBe(false);
    expect((await download(c.app, b, audioMsg)).statusCode).toBe(404);
    const afterDelete = (await req(c.app, 'GET', '/api/sync?after=0', b)).json<{ changes: { message: MessageJson['message'] }[] }>();
    const tomb = afterDelete.changes.find((ch) => ch.message.id === doomedId)?.message;
    expect(tomb?.attachments).toEqual([expect.objectContaining({ id: audioMsg, expired: true })]);

    // 7) 보존: 미결속은 1시간 뒤 행 삭제, 오디오 30일·이미지 90일 경과 시 바이트 삭제 + 메타 유지.
    now += 2 * 60 * 60 * 1000;
    await retention(c);
    for (const unbound of [maxId, bOwn, elsewhere]) {
      expect((await c.schema.pool.query('SELECT 1 FROM attachments WHERE id = $1', [unbound])).rowCount, unbound).toBe(0);
    }
    expect(await blobExists(c.schema, pngId)).toBe(true);
    expect(await blobExists(c.schema, audioId)).toBe(true);
    now += (ATTACHMENT_RETENTION_DAYS.audio + 1) * DAY;
    await retention(c);
    expect(await blobExists(c.schema, audioId)).toBe(false);
    expect(await blobExists(c.schema, pngId)).toBe(true);
    now += (ATTACHMENT_RETENTION_DAYS.image - ATTACHMENT_RETENTION_DAYS.audio) * DAY;
    await retention(c);
    expect(await blobExists(c.schema, pngId)).toBe(false);
    const meta = await c.schema.pool.query<{ id: string; deleted: boolean }>(
      'SELECT id, deleted_at IS NOT NULL AS deleted FROM attachments WHERE message_id = $1 ORDER BY id',
      [msg.id],
    );
    expect(meta.rows).toEqual([pngId, audioId].sort().map((id) => ({ id, deleted: true })));
  });
});
