import { PassThrough } from 'node:stream';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { ATTACHMENT_DOC_MAX_BYTES, ATTACHMENT_FILENAME_HEADER, ATTACHMENT_HUMAN_CONCURRENT_UPLOADS, ATTACHMENT_MAX_BYTES } from '../../src/shared.js';
import type { Session } from '../auth/members-int-harness.js';
import { setupBotListener, teardownBotListener, type BotListenerContext } from '../bots/bot-listener-harness.js';
import { as, createChannel, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { HOST, ORIGIN } from '../support/auth-app.js';
import { counts, png } from './att-harness.js';

/** FR-OPS-09 보조(TRD §6-1-1 (2)·(4)): 문서 25 MiB 경계·미디어 10 MiB 유지(사람·봇), 사람 동시 업로드 상한 429. */
let ctx: ConvIntContext | undefined;
let lc: BotListenerContext | undefined;

afterEach(async () => {
  await teardownConvInt(ctx);
  ctx = undefined;
  await teardownBotListener(lc);
  lc = undefined;
});

const BIG_TIMEOUT_MS = 60_000;
const PDF_HEAD = Buffer.from('%PDF-1.7\n', 'latin1');
/** 정확히 `size`바이트 PDF(머리 + 공백 채움 — EOCD 서명 없음). */
const pdfOf = (size: number): Buffer => Buffer.concat([PDF_HEAD, Buffer.alloc(size - PDF_HEAD.length, 0x20)]);
/** 정확히 `size`바이트 PNG. */
const pngOf = (size: number): Buffer => png(2, 3, size - png().length);

function humanHeaders(session: Session, contentType: string, filename?: string): Record<string, string> {
  return {
    host: HOST,
    origin: ORIGIN,
    cookie: `${SESSION_COOKIE}=${session.token}`,
    'x-csrf-token': session.csrf,
    'content-type': contentType,
    ...(filename === undefined ? {} : { [ATTACHMENT_FILENAME_HEADER]: filename }),
  };
}

function humanUpload(app: FastifyInstance, session: Session, conversationId: string, bytes: Buffer, contentType: string, filename?: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: `/api/attachments?conversation_id=${conversationId}`, headers: humanHeaders(session, contentType, filename), payload: bytes });
}

/** 봇 라우트는 inject로 부른다(실소켓은 413 직후 연결 종료로 EPIPE가 날 수 있다). 헤더는 리스너 하네스와 같다. */
function botUpload(c: BotListenerContext, bytes: Buffer, contentType: string, filename?: string): Promise<LightMyRequestResponse> {
  return c.botApp.inject({
    method: 'POST',
    url: `/api/bot/v1/attachments?conversation_id=${c.bot.dmConversationId}`,
    headers: {
      host: `127.0.0.1:${c.botPort}`,
      authorization: `Bearer ${c.token}`,
      'content-type': contentType,
      ...(filename === undefined ? {} : { [ATTACHMENT_FILENAME_HEADER]: filename }),
    },
    payload: bytes,
  });
}

type Uploader = (bytes: Buffer, contentType: string, filename?: string) => Promise<LightMyRequestResponse>;

/** 문서 정확히 상한 201·+1 413, 미디어 정확히 10 MiB 201·+1 413(문서 상한 안이어도). 저장 수는 201 건수와 같다. */
async function assertSizeBoundaries(send: Uploader, stored: () => Promise<number>): Promise<void> {
  const base = await stored();
  const atDoc = await send(pdfOf(ATTACHMENT_DOC_MAX_BYTES), 'application/pdf', 'max.pdf');
  expect(atDoc.statusCode, atDoc.body).toBe(201);
  expect(atDoc.json()).toMatchObject({ attachment: { mime: 'application/pdf', byte_size: ATTACHMENT_DOC_MAX_BYTES, filename: 'max.pdf' } });
  expect((await send(pdfOf(ATTACHMENT_DOC_MAX_BYTES + 1), 'application/pdf', 'over.pdf')).statusCode).toBe(413);
  const atMedia = await send(pngOf(ATTACHMENT_MAX_BYTES), 'image/png');
  expect(atMedia.statusCode, atMedia.body).toBe(201);
  expect((await send(pngOf(ATTACHMENT_MAX_BYTES + 1), 'image/png')).statusCode).toBe(413);
  expect(await stored()).toBe(base + 2);
}

/** body를 끝내지 않은 업로드: 자리를 잡은 요청은 body를 기다리며 멈추고, 자리를 못 잡은 요청은 onRequest에서 429로 끝난다. */
function heldUpload(app: FastifyInstance, session: Session, conversationId: string, bytes: Buffer) {
  const body = new PassThrough();
  const response = app.inject({
    method: 'POST',
    url: `/api/attachments?conversation_id=${conversationId}`,
    headers: { ...humanHeaders(session, 'image/png'), 'content-length': String(bytes.length) },
    payload: body,
  });
  let settled = false;
  void response.then(
    () => (settled = true),
    () => (settled = true),
  );
  return { response, release: () => body.end(bytes), isSettled: () => settled };
}

describe('문서 첨부 상한(FR-OPS-09 보조)', () => {
  it(
    '사람 라우트: 문서는 26,214,400바이트까지 저장되고 +1바이트는 413, 미디어는 10 MiB 상한을 유지한다',
    async () => {
      ctx = await setupConvInt();
      const c = ctx;
      const a = await as(c.app, 'a');
      const channel = await createChannel(c.app, a, 'limits');
      await assertSizeBoundaries(
        (bytes, type, name) => humanUpload(c.app, a, channel, bytes, type, name),
        async () => (await counts(c.schema)).meta,
      );
      expect(await counts(c.schema)).toEqual({ meta: 2, blobs: 2 });
    },
    BIG_TIMEOUT_MS,
  );

  it(
    '봇 라우트: 같은 문서 25 MiB·미디어 10 MiB 경계를 쓴다',
    async () => {
      lc = await setupBotListener();
      const c = lc;
      const stored = async () =>
        Number((await c.conv.schema.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM attachments WHERE uploader_id = $1', [c.bot.botUserId])).rows[0]?.n);
      await assertSizeBoundaries((bytes, type, name) => botUpload(c, bytes, type, name), stored);
    },
    BIG_TIMEOUT_MS,
  );

  it('사람 계정 동시 업로드 10건 중 상한만큼만 진행되고 나머지는 429이며 끝난 뒤 자리가 돌아온다', async () => {
    ctx = await setupConvInt();
    const c = ctx;
    const a = await as(c.app, 'a');
    const channel = await createChannel(c.app, a, 'concurrent');
    const total = 10;
    const bytes = png();
    const held = Array.from({ length: total }, () => heldUpload(c.app, a, channel, bytes));

    // body를 아무것도 보내지 않은 상태: 자리는 응답 종료 때만 돌아오므로 정확히 상한 건만 onRequest를 지난다.
    const rejected = total - ATTACHMENT_HUMAN_CONCURRENT_UPLOADS;
    const early = await new Promise<LightMyRequestResponse[]>((resolve, reject) => {
      const done: LightMyRequestResponse[] = [];
      for (const h of held) {
        h.response.then((res) => {
          done.push(res);
          if (done.length === rejected) resolve(done);
        }, reject);
      }
    });
    expect(early.map((r) => r.statusCode)).toEqual(Array.from({ length: rejected }, () => 429));
    expect(early.every((r) => r.json<{ error: { code: string } }>().error.code === 'rate_limited')).toBe(true);
    expect(held.filter((h) => !h.isSettled())).toHaveLength(ATTACHMENT_HUMAN_CONCURRENT_UPLOADS);
    expect(await counts(c.schema)).toEqual({ meta: 0, blobs: 0 });

    for (const h of held) h.release();
    const all = await Promise.all(held.map((h) => h.response));
    const statuses = all.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201)).toHaveLength(ATTACHMENT_HUMAN_CONCURRENT_UPLOADS);
    expect(statuses.filter((s) => s === 429)).toHaveLength(rejected);
    expect(await counts(c.schema)).toEqual({ meta: ATTACHMENT_HUMAN_CONCURRENT_UPLOADS, blobs: ATTACHMENT_HUMAN_CONCURRENT_UPLOADS });

    // 응답이 끝나면 자리가 돌아온다: 다음 상한 건수 동시 업로드가 모두 201.
    const next = await Promise.all(Array.from({ length: ATTACHMENT_HUMAN_CONCURRENT_UPLOADS }, () => humanUpload(c.app, a, channel, bytes, 'image/png')));
    expect(next.map((r) => r.statusCode)).toEqual(Array.from({ length: ATTACHMENT_HUMAN_CONCURRENT_UPLOADS }, () => 201));
  });
});
