import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createPgAttachmentsStore, bindInTx, boundIdsOf, purgeMessageBlobsInTx } from '../../src/modules/attachments/repo.js';
import type { AttachmentMeta, AttachmentsStore } from '../../src/modules/attachments/repo.js';
import { attachmentCspOnSend, downloadAs, parseRange, registerUploadRoute, toAttachmentView, uploadAs } from '../../src/modules/attachments/routes.js';
import { createAttachmentsService, isExpired, retentionMs, startRetentionTimer } from '../../src/modules/attachments/service.js';
import { declaredType, sniff } from '../../src/modules/attachments/sniff.js';
import type { ConversationsService } from '../../src/modules/conversations/service.js';
import { ATTACHMENT_MAX_BYTES } from '../../src/shared.js';
import { HTML, jpeg, mp3, png, webp } from './att-harness.js';

/** attachments 모듈 단위(정본: TRD §6-1). DB 경로는 int 테스트(FR-OPS-05)가 증명하고, 여기서는 분기·SQL 순서만 본다. */
const meta = (over: Partial<AttachmentMeta> = {}): AttachmentMeta => ({
  id: '00000000-0000-4000-8000-000000000001',
  conversationId: 'c1',
  uploaderId: 'u1',
  messageId: null,
  mime: 'image/png',
  byteSize: 33,
  durationMs: null,
  width: 2,
  height: 3,
  createdAt: new Date(0),
  expiresAt: new Date(10_000),
  deletedAt: null,
  ...over,
});

describe('sniff', () => {
  it('4형식을 내용으로 판정하고 크기·길이를 헤더에서 읽는다', () => {
    expect(sniff(png(9, 8))).toMatchObject({ mime: 'image/png', width: 9, height: 8 });
    expect(sniff(jpeg(5, 4))).toMatchObject({ mime: 'image/jpeg', width: 5, height: 4 });
    expect(sniff(webp(7, 6))).toMatchObject({ mime: 'image/webp', width: 7, height: 6 });
    expect(sniff(mp3(16_000))).toMatchObject({ mime: 'audio/mpeg', durationMs: 1000 });
    // ID3 없는 프레임 sync, MPEG2 Layer III(24kbps 22.05kHz).
    const bare = Buffer.alloc(3000);
    Buffer.from([0xff, 0xf3, 0x30, 0xc4]).copy(bare);
    expect(sniff(bare)).toMatchObject({ mime: 'audio/mpeg', durationMs: 1000 });
  });

  it('Xing 프레임 수가 있으면 VBR 길이, Layer II는 길이 null', () => {
    const b = Buffer.alloc(200);
    Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(b);
    b.write('Xing', 36, 'latin1');
    b.writeUInt32BE(1, 40);
    b.writeUInt32BE(100, 44);
    expect(sniff(b)?.durationMs).toBe(Math.round((100 * 1152 * 1000) / 44100));
    const layer2 = Buffer.alloc(200);
    Buffer.from([0xff, 0xfd, 0x90, 0x64]).copy(layer2);
    expect(sniff(layer2)).toMatchObject({ mime: 'audio/mpeg', durationMs: null });
  });

  it('webp VP8·VP8L, 크기 없는 jpeg', () => {
    const vp8 = Buffer.alloc(30);
    vp8.write('RIFF', 0, 'latin1');
    vp8.write('WEBP', 8, 'latin1');
    vp8.write('VP8 ', 12, 'latin1');
    vp8.writeUInt16LE(11, 26);
    vp8.writeUInt16LE(12, 28);
    expect(sniff(vp8)).toMatchObject({ width: 11, height: 12 });
    const vp8l = Buffer.alloc(30);
    vp8l.write('RIFF', 0, 'latin1');
    vp8l.write('WEBP', 8, 'latin1');
    vp8l.write('VP8L', 12, 'latin1');
    vp8l[20] = 0x2f;
    vp8l.writeUInt32LE((3 - 1) | ((4 - 1) << 14), 21);
    expect(sniff(vp8l)).toMatchObject({ width: 3, height: 4 });
    const unknown = Buffer.alloc(16);
    unknown.write('RIFF', 0, 'latin1');
    unknown.write('WEBP', 8, 'latin1');
    expect(sniff(unknown)).toMatchObject({ mime: 'image/webp', width: null });
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toMatchObject({ mime: 'image/jpeg', width: null });
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xd0, 0xff, 0xda, 0, 0]))).toMatchObject({ mime: 'image/jpeg', width: null });
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00, 0x00]))).toMatchObject({ mime: 'image/jpeg', width: null });
  });

  it('HTML·SVG·잘린 PNG·ID3+HTML·예약 프레임은 판정되지 않는다', () => {
    expect(sniff(HTML)).toBeUndefined();
    expect(sniff(png().subarray(0, 20))).toBeUndefined();
    const badChunk = png();
    badChunk.write('IDAT', 12, 'latin1');
    expect(sniff(badChunk)).toBeUndefined();
    expect(sniff(Buffer.concat([Buffer.from('ID3\x04\x10\x00\x00\x00\x00\x00', 'latin1'), HTML]))).toBeUndefined();
    expect(sniff(Buffer.from([0xff, 0xeb, 0x90, 0x64]))).toBeUndefined(); // version 01(예약)
    expect(sniff(Buffer.from([0xff, 0xfb, 0xf0, 0x64]))).toBeUndefined(); // bitrate 1111
  });

  it('declaredType은 매개변수를 떼고 소문자로 만든다', () => {
    expect(declaredType('Image/PNG; charset=binary')).toBe('image/png');
    expect(declaredType(undefined)).toBe('');
  });
});

describe('parseRange', () => {
  it('단일 범위·접미·열린 끝은 범위, 다중·문법 오류·역순은 전체, 범위 밖은 416', () => {
    expect(parseRange(undefined, 10)).toBe('full');
    expect(parseRange('bytes=2-4', 10)).toEqual({ start: 2, end: 4 });
    expect(parseRange('bytes=2-', 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=-30', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=2-99', 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange('bytes=0-1,3-4', 10)).toBe('full');
    expect(parseRange('items=0-1', 10)).toBe('full');
    expect(parseRange('bytes=-', 10)).toBe('full');
    expect(parseRange('bytes=5-2', 10)).toBe('full');
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 10)).toBe('unsatisfiable');
  });
});

function fakeStore(over: Partial<AttachmentsStore> = {}): AttachmentsStore & { inserted: unknown[] } {
  const inserted: unknown[] = [];
  return {
    inserted,
    insert: async (a) => {
      inserted.push(a);
      return meta({ id: a.id, mime: a.mime, byteSize: a.byteSize, expiresAt: a.expiresAt });
    },
    get: async () => meta(),
    bytes: async () => png(),
    retain: async () => ({ unboundDeleted: 1, blobsDeleted: 2 }),
    ...over,
  };
}

const allow = { assertAccess: vi.fn(async () => undefined) } as unknown as ConversationsService;

describe('service', () => {
  it('upload: 판정 불일치 415·빈 본문 400·상한 초과 413은 저장 0, 일치는 보존 기한을 붙여 저장', async () => {
    const store = fakeStore();
    const service = createAttachmentsService({ store, conversations: allow, clock: () => 1000 });
    await expect(service.upload('u1', 'c1', 'image/jpeg', png())).rejects.toMatchObject({ statusCode: 415 });
    await expect(service.upload('u1', 'c1', 'text/html', HTML)).rejects.toMatchObject({ statusCode: 415 });
    await expect(service.upload('u1', 'c1', 'image/png', Buffer.alloc(0))).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.upload('u1', 'c1', 'image/png', Buffer.alloc(ATTACHMENT_MAX_BYTES + 1))).rejects.toMatchObject({ statusCode: 413 });
    expect(store.inserted).toHaveLength(0);
    const saved = await service.upload('u1', 'c1', 'audio/mpeg', mp3());
    expect(saved.expiresAt.getTime()).toBe(1000 + retentionMs('audio/mpeg'));
    expect(retentionMs('image/png')).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it('resolveAccess는 assertAccess 하나로 판정하고 없는 첨부는 404, read는 만료·blob 없음 404', async () => {
    const service = createAttachmentsService({ store: fakeStore({ get: async () => undefined }), conversations: allow, clock: () => 0 });
    await expect(service.resolveAccess('u1', 'x', 'read')).rejects.toMatchObject({ statusCode: 404 });
    const live = createAttachmentsService({ store: fakeStore(), conversations: allow, clock: () => 0 });
    expect((await live.resolveAccess('u1', 'x', 'read')).conversationId).toBe('c1');
    expect(allow.assertAccess).toHaveBeenCalledWith('u1', 'c1', 'read');
    expect((await live.read(meta())).bytes.equals(png())).toBe(true);
    await expect(live.read(meta({ deletedAt: new Date(0) }))).rejects.toMatchObject({ statusCode: 404 });
    const late = createAttachmentsService({ store: fakeStore(), conversations: allow, clock: () => 20_000 });
    await expect(late.read(meta())).rejects.toMatchObject({ statusCode: 404 });
    const gone = createAttachmentsService({ store: fakeStore({ bytes: async () => undefined }), conversations: allow, clock: () => 0 });
    await expect(gone.read(meta())).rejects.toMatchObject({ statusCode: 404 });
    expect(isExpired(meta(), 9_999)).toBe(false);
    expect(await live.runRetention()).toEqual({ unboundDeleted: 1, blobsDeleted: 2 });
  });

  it('보존 타이머는 주기마다 실행하고 겹치지 않으며 실패를 onError로 넘기고 정지된다', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const errors: unknown[] = [];
      const service = { runRetention: async () => { calls += 1; throw new Error('x'); } } as unknown as Parameters<typeof startRetentionTimer>[0];
      const stop = startRetentionTimer(service, 1000, (e) => errors.push(e));
      await vi.advanceTimersByTimeAsync(3100);
      stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(3);
      expect(errors).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('routes(처리 본문)', () => {
  it('업로드 범위만 원시 바이트·10 MiB를 받고, 다운로드는 sandbox CSP·Range를 낸다', async () => {
    const service = createAttachmentsService({ store: fakeStore(), conversations: allow, clock: () => 0 });
    const app = Fastify();
    registerUploadRoute(app, '/up', { access: 'account', preHandler: [] }, (request, reply) => uploadAs(service, 'u1', request, reply, () => 0));
    app.get('/down', { onSend: attachmentCspOnSend }, (request, reply) => downloadAs(service, meta(), request, reply));
    app.post('/json', async () => 'ok');
    const up = await app.inject({ method: 'POST', url: '/up?conversation_id=00000000-0000-4000-8000-000000000009', headers: { 'content-type': 'image/png' }, payload: png() });
    expect(up.statusCode).toBe(201);
    expect(up.json()).toMatchObject({ attachment: { mime: 'image/png', expired: false } });
    expect((await app.inject({ method: 'POST', url: '/up', headers: { 'content-type': 'image/png' }, payload: png() })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/json', headers: { 'content-type': 'image/png' }, payload: png() })).statusCode).toBe(415);
    const down = await app.inject({ method: 'GET', url: '/down', headers: { range: 'bytes=0-3' } });
    expect(down.statusCode).toBe(206);
    expect(down.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect((await app.inject({ method: 'GET', url: '/down', headers: { range: 'bytes=999-' } })).statusCode).toBe(416);
    expect((await app.inject({ method: 'GET', url: '/down' })).statusCode).toBe(200);
    expect(toAttachmentView(meta({ deletedAt: new Date(0) }), 0).expired).toBe(true);
    await app.close();
  });
});

type Q = { text: string; params: unknown[] };

function fakeDb(answer: (sql: string) => { rows: unknown[]; rowCount: number } = () => ({ rows: [], rowCount: 0 })) {
  const log: Q[] = [];
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    log.push({ text, params });
    return answer(text);
  });
  return { log, client: { query, release: vi.fn() } };
}

describe('repo(SQL 순서)', () => {
  it('bindInTx: 빈 목록·중복·불일치는 결속하지 않고, 일치하면 잠근 뒤 message_id를 채운다', async () => {
    const empty = fakeDb();
    const args = { messageId: 'm1', conversationId: 'c1', uploaderId: 'u1', notBefore: new Date(0) };
    expect(await bindInTx(empty.client as never, { ...args, ids: [] })).toBe('ok');
    expect(await bindInTx(empty.client as never, { ...args, ids: ['a', 'a'] })).toBe('invalid');
    expect(empty.log).toHaveLength(0);
    const miss = fakeDb(() => ({ rows: [{ id: 'a' }], rowCount: 1 }));
    expect(await bindInTx(miss.client as never, { ...args, ids: ['a', 'b'] })).toBe('invalid');
    expect(miss.log).toHaveLength(1);
    const hit = fakeDb(() => ({ rows: [{ id: 'a' }, { id: 'b' }], rowCount: 2 }));
    expect(await bindInTx(hit.client as never, { ...args, ids: ['a', 'b'] })).toBe('ok');
    expect(hit.log.map((q) => q.text.trim().split(/\s+/).slice(0, 2).join(' '))).toEqual(['SELECT id', 'UPDATE attachments']);
    expect(await boundIdsOf(hit.client as never, 'm1')).toEqual(['a', 'b']);
    await purgeMessageBlobsInTx(hit.client as never, 'm1', new Date(0));
    expect(hit.log.at(-1)?.text).toContain('DELETE FROM attachment_blobs');
  });

  it('pg store: insert는 메타·blob을 한 트랜잭션으로, 실패는 ROLLBACK, retain은 세 문장', async () => {
    const row = { id: 'a', conversation_id: 'c1', uploader_id: 'u1', message_id: null, mime: 'image/png', byte_size: 1, duration_ms: null, width: 1, height: 1, created_at: new Date(0), expires_at: new Date(1), deleted_at: null };
    const ok = fakeDb((sql) => (sql.startsWith('INSERT INTO attachments') ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 1 }));
    const pool = { connect: async () => ok.client, query: ok.client.query };
    const store = createPgAttachmentsStore(pool as never);
    const input = { ...meta(), sha256: 'x', bytes: png() };
    expect((await store.insert(input)).id).toBe('a');
    expect(ok.log.map((q) => q.text.split(' ')[0])).toEqual(['BEGIN', 'INSERT', 'INSERT', 'COMMIT']);
    const bad = fakeDb((sql) => {
      if (sql.startsWith('INSERT INTO attachment_blobs')) throw new Error('boom');
      return { rows: [row], rowCount: 1 };
    });
    await expect(createPgAttachmentsStore({ connect: async () => bad.client, query: bad.client.query } as never).insert(input)).rejects.toThrow('boom');
    expect(bad.log.at(-1)?.text).toBe('ROLLBACK');
    expect(await store.get('a')).toBeUndefined();
    expect(await store.bytes('a')).toBeUndefined();
    expect(await store.retain(new Date(0), new Date(0))).toEqual({ unboundDeleted: 1, blobsDeleted: 2 });
    const empty = fakeDb((sql) => (sql.startsWith('INSERT INTO attachments') ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 }));
    await expect(createPgAttachmentsStore({ connect: async () => empty.client, query: empty.client.query } as never).insert(input)).rejects.toThrow();
    const found = fakeDb((sql) => (sql.includes('FROM attachments WHERE id') ? { rows: [row], rowCount: 1 } : { rows: [{ bytes: png() }], rowCount: 1 }));
    const s2 = createPgAttachmentsStore({ connect: async () => found.client, query: found.client.query } as never);
    expect((await s2.get('a'))?.conversationId).toBe('c1');
    expect((await s2.bytes('a'))?.equals(png())).toBe(true);
  });
});
