import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { ATTACHMENT_DOC_MIMES, ATTACHMENT_FILENAME_HEADER, ATTACHMENT_TEXT_MIMES } from '../../src/shared.js';
import type { Session } from '../auth/members-int-harness.js';
import { as, createChannel, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { HOST, ORIGIN } from '../support/auth-app.js';
import { counts } from './att-harness.js';
import { buildZip, docxEntries, pptxEntries, xlsxEntries } from './fixtures/zip-builder.js';

/** W-26 Codex r1 회귀(라우트 경유): 매크로 OOXML 실제 MIME 선언 201, 텍스트 계열 파일명 헤더 누락 400, 프로토타입 확장자 415. */
let ctx: ConvIntContext | undefined;

afterEach(async () => {
  await teardownConvInt(ctx);
  ctx = undefined;
});

const [, , DOCM, , XLSM, , PPTM] = ATTACHMENT_DOC_MIMES;

function send(app: FastifyInstance, session: Session, conversationId: string, bytes: Buffer, contentType: string, filename?: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/attachments?conversation_id=${conversationId}`,
    headers: {
      host: HOST,
      origin: ORIGIN,
      cookie: `${SESSION_COOKIE}=${session.token}`,
      'x-csrf-token': session.csrf,
      'content-type': contentType,
      ...(filename === undefined ? {} : { [ATTACHMENT_FILENAME_HEADER]: filename }),
    },
    payload: bytes,
  });
}

describe('문서 첨부 Codex r1 회귀', () => {
  it('매크로 .docm/.xlsm/.pptm을 원래 대소문자 MIME으로 선언하면 201이고 저장 MIME은 표 그대로다', async () => {
    ctx = await setupConvInt();
    const c = ctx;
    const a = await as(c.app, 'a');
    const channel = await createChannel(c.app, a, 'macro-mime');
    const cases = [
      { bytes: buildZip(docxEntries([{ name: 'word/vbaProject.bin' }])), mime: DOCM, name: 'm.docm' },
      { bytes: buildZip(xlsxEntries([{ name: 'xl/vbaProject.bin' }])), mime: XLSM, name: 'm.xlsm' },
      { bytes: buildZip(pptxEntries([{ name: 'ppt/vbaProject.bin' }])), mime: PPTM, name: 'm.pptm' },
    ];
    for (const k of cases) {
      const res = await send(c.app, a, channel, k.bytes, String(k.mime), k.name);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({ attachment: { mime: k.mime, filename: k.name, has_macros: true } });
    }
    expect(await counts(c.schema)).toEqual({ meta: 3, blobs: 3 });
  });

  it('텍스트 계열 3종은 파일명 헤더가 없으면 400, 허용목록 밖 프로토타입 확장자는 415이며 저장 0이다', async () => {
    ctx = await setupConvInt();
    const c = ctx;
    const a = await as(c.app, 'a');
    const channel = await createChannel(c.app, a, 'text-name');
    for (const mime of ATTACHMENT_TEXT_MIMES) {
      const res = await send(c.app, a, channel, Buffer.from('a,b\n'), mime);
      expect(res.statusCode, `${mime} ${res.body}`).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    }
    for (const ext of ['constructor', '__proto__', 'toString']) {
      const res = await send(c.app, a, channel, Buffer.from('hello\n'), 'application/octet-stream', `a.${ext}`);
      expect(res.statusCode, `${ext} ${res.body}`).toBe(415);
    }
    expect(await counts(c.schema)).toEqual({ meta: 0, blobs: 0 });
  });
});
