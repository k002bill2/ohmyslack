import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { ATTACHMENT_DOC_RETENTION_DAYS, ATTACHMENT_FILENAME_HEADER } from '../../src/shared.js';
import type { Session } from '../auth/members-int-harness.js';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { HOST, ORIGIN } from '../support/auth-app.js';
import { download } from './att-harness.js';

/**
 * 「받기」 사전 확인(웹 W3 지원, QA B7): `HEAD /api/attachments/:id`는 GET과 같은 인가·만료 판정을 거친다.
 * 정상 → 200 + GET과 같은 헤더(본문 없음), 만료·삭제·비참여자·미결속(비업로더)·없는 ID → GET과 같은 404(본문 없음, 존재 은폐).
 */
let ctx: ConvIntContext | undefined;
const DAY = 24 * 60 * 60 * 1000;
const PDF = Buffer.from('%PDF-1.7\n%%EOF\n', 'latin1');
const SAME_HEADERS = ['content-type', 'content-disposition', 'content-length', 'accept-ranges', 'cache-control', 'x-content-type-options', 'content-security-policy'] as const;

afterEach(async () => {
  await teardownConvInt(ctx);
  ctx = undefined;
});

const authHeaders = (session: Session): Record<string, string> => ({ host: HOST, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${session.token}` });

function head(app: FastifyInstance, session: Session, id: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'HEAD', url: `/api/attachments/${id}`, headers: authHeaders(session) });
}

async function uploadPdf(app: FastifyInstance, session: Session, conversationId: string, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/attachments?conversation_id=${conversationId}`,
    headers: { ...authHeaders(session), 'x-csrf-token': session.csrf, 'content-type': 'application/pdf', [ATTACHMENT_FILENAME_HEADER]: encodeURIComponent(name) },
    payload: PDF,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ attachment_id: string }>().attachment_id;
}

/** HEAD와 GET이 같은 상태 코드이고 HEAD 본문은 비어 있다. */
async function sameAsGet(app: FastifyInstance, session: Session, id: string, status: number): Promise<LightMyRequestResponse> {
  const got = await download(app, session, id);
  const headed = await head(app, session, id);
  expect(got.statusCode).toBe(status);
  expect(headed.statusCode).toBe(status);
  expect(headed.body).toBe('');
  return headed;
}

describe('첨부 HEAD 사전 확인(B7)', () => {
  it('정상 첨부는 200 + GET과 같은 헤더(본문 없음), 보존 만료는 retention 전·후 모두 GET과 같은 404', async () => {
    let now = Date.now();
    ctx = await setupConvInt({ clock: () => now });
    const c = ctx;
    const a = await as(c.app, 'a');
    const b = await as(c.app, 'b');
    const channel = await createChannel(c.app, a, 'head');
    await req(c.app, 'POST', `/api/conversations/${channel}/join`, b);
    const uploadedAt = now;
    const id = await uploadPdf(c.app, a, channel, '보고서.pdf');
    const sent = await req(c.app, 'POST', `/api/conversations/${channel}/messages`, a, { client_message_id: randomUUID(), body: '문서', attachment_ids: [id] });
    expect(sent.statusCode).toBe(201);

    for (const who of [a, b]) {
      const got = await download(c.app, who, id);
      const headed = await sameAsGet(c.app, who, id, 200);
      expect(got.rawPayload.length).toBe(PDF.length);
      for (const name of SAME_HEADERS) expect(headed.headers[name], name).toBe(got.headers[name]);
      expect(headed.headers['content-disposition']).toMatch(/^attachment; /u);
    }

    // 보존 기한이 지난 직후(바이트 삭제 전) — isExpired 판정.
    now = uploadedAt + ATTACHMENT_DOC_RETENTION_DAYS * DAY + 1000;
    const later = await as(c.app, 'b'); // 시계 이동으로 이전 세션은 만료(401)라 다시 로그인한다.
    await sameAsGet(c.app, later, id, 404);
    // retention 실행 뒤(바이트 삭제됨).
    const service = c.app.domainServices?.attachments;
    if (service === undefined) throw new Error('첨부 서비스 없음');
    await service.runRetention();
    const after = await sameAsGet(c.app, later, id, 404);
    expect(after.headers['content-disposition']).toBeUndefined();
  });

  it('인가 실패(비참여자·미결속 첨부의 비업로더·없는 ID)는 HEAD에서도 GET과 같은 404다', async () => {
    ctx = await setupConvInt();
    const c = ctx;
    const a = await as(c.app, 'a');
    const b = await as(c.app, 'b');
    const outsider = await as(c.app, 'c');
    const channel = await createChannel(c.app, a, 'deny');
    await req(c.app, 'POST', `/api/conversations/${channel}/join`, b);
    const unbound = await uploadPdf(c.app, a, channel, 'draft.pdf');

    await sameAsGet(c.app, a, unbound, 200);
    const denied = [
      await sameAsGet(c.app, outsider, unbound, 404),
      await sameAsGet(c.app, b, unbound, 404),
      await sameAsGet(c.app, a, randomUUID(), 404),
      await sameAsGet(c.app, a, 'not-a-uuid', 404),
    ];
    // 존재 여부가 헤더로 새지 않는다: 거부 응답끼리 헤더 모양이 같고 파일 헤더가 없다.
    for (const res of denied) {
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.headers['content-type']).toBe(denied[0]?.headers['content-type']);
      expect(res.headers['content-length']).toBe(denied[0]?.headers['content-length']);
    }
  });
});
