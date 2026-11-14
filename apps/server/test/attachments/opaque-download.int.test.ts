import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { attachmentDisposition } from '../../src/modules/attachments/filename.js';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { ATTACHMENT_FILENAME_HEADER } from '../../src/shared.js';
import type { Session } from '../auth/members-int-harness.js';
import { http, setupBotListener, teardownBotListener, type BotListenerContext } from '../bots/bot-listener-harness.js';
import { as, createChannel, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { HOST, ORIGIN } from '../support/auth-app.js';
import { download, png, uploadedId } from './att-harness.js';

/**
 * 실기 r3(2026-11-14, iOS 홈 화면 앱): 사람 다운로드의 문서·텍스트는 `Content-Type: application/octet-stream`으로 보낸다 —
 * 범위 안 링크라 PDF·텍스트가 앱 창 안에서 열려 돌아올 수 없던 문제(TRD §6-1-1 (6)). 파일명은 Content-Disposition 그대로,
 * 본래 mime은 projection에 남고, 미디어(inline)와 봇 다운로드 라우트는 원래 mime이다.
 * 참고 출처: 일반 관념, 저장소 내부 문서, 실기 관찰(dev/handoff/qa-iphone-r3-20261114).
 */
let ctx: ConvIntContext | undefined;
let lc: BotListenerContext | undefined;

afterEach(async () => {
  await teardownConvInt(ctx);
  ctx = undefined;
  if (lc !== undefined) await teardownBotListener(lc);
  lc = undefined;
});

const OCTET = 'application/octet-stream';
const PDF = Buffer.from('%PDF-1.7\n%%EOF\n', 'latin1');
const TEXT = Buffer.from('내용\n');
// S1 재현형: NFD로는 255바이트를 넘는 긴 한글 이름(헤더에서만 음절 경계로 줄어든다).
const LONG_PDF = `2026년_하반기_조직개편_관련_부서별_인력배치_계획안_및_예산_검토_요청서_인사팀_총무팀_공동작성본_최종_수정본_회의자료_첨부_꼭_검토용_부탁드립니다.pdf`;

function docUpload(app: FastifyInstance, session: Session, conversationId: string, bytes: Buffer, name: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/attachments?conversation_id=${conversationId}`,
    headers: {
      host: HOST,
      origin: ORIGIN,
      cookie: `${SESSION_COOKIE}=${session.token}`,
      'x-csrf-token': session.csrf,
      'content-type': OCTET,
      [ATTACHMENT_FILENAME_HEADER]: encodeURIComponent(name),
    },
    payload: bytes,
  });
}

describe('사람 다운로드 문서·텍스트는 octet-stream(실기 r3)', () => {
  it.each([
    ['report.pdf', PDF, 'application/pdf'],
    ['메모.txt', TEXT, 'text/plain'],
    ['노트.md', TEXT, 'text/markdown'],
    [LONG_PDF, PDF, 'application/pdf'],
  ] as const)('%s → GET·HEAD 모두 octet-stream, 파일명 헤더·nosniff 그대로, projection mime은 원래 값', async (name, bytes, mime) => {
    ctx = await setupConvInt();
    const c = ctx;
    const a = await as(c.app, 'a');
    const channel = await createChannel(c.app, a, 'opaque');
    const up = await docUpload(c.app, a, channel, bytes, name);
    expect(up.statusCode, up.body).toBe(201);
    const body = up.json<{ attachment_id: string; attachment: { mime: string; filename: string } }>();
    expect(body.attachment.mime).toBe(mime);
    expect(body.attachment.filename).toBe(name);
    for (const res of [await download(c.app, a, body.attachment_id), await c.app.inject({ method: 'HEAD', url: `/api/attachments/${body.attachment_id}`, headers: { host: HOST, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${a.token}` } })]) {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe(OCTET);
      expect(res.headers['content-disposition']).toBe(attachmentDisposition(name));
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('미디어(inline)는 원래 mime 그대로', async () => {
    ctx = await setupConvInt();
    const c = ctx;
    const a = await as(c.app, 'a');
    const channel = await createChannel(c.app, a, 'media');
    const id = await uploadedId(c.app, a, channel, png(), 'image/png');
    const res = await download(c.app, a, id);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe('inline');
  });
});

describe('봇 다운로드 라우트는 원래 mime 그대로(Hermes가 읽음)', () => {
  it.each([
    ['report.pdf', PDF, 'application/pdf', 'application/pdf'],
    ['memo.txt', TEXT, 'text/plain', 'text/plain; charset=utf-8'],
  ] as const)('%s 업로드 → 봇 GET content-type 원래 값', async (name, bytes, declared, type) => {
    lc = await setupBotListener();
    const dm = lc.bot.dmConversationId;
    const up = await http(
      lc.botPort,
      'POST',
      `/api/bot/v1/attachments?conversation_id=${dm}`,
      { authorization: `Bearer ${lc.token}`, 'content-type': declared, [ATTACHMENT_FILENAME_HEADER]: name },
      bytes,
    );
    expect(up.status).toBe(201);
    const id = up.json.attachment_id as string;
    const res = await http(lc.botPort, 'GET', `/api/bot/v1/attachments/${id}`, { authorization: `Bearer ${lc.token}` });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(type);
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="/u);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
