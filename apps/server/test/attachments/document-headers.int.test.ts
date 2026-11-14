import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { ATTACHMENT_DOC_RETENTION_DAYS, ATTACHMENT_FILENAME_HEADER, ATTACHMENT_FILENAME_HEADER_MAX_BYTES, ATTACHMENT_FILENAME_MAX_BYTES, ATTACHMENT_FILENAME_MAX_CHARS } from '../../src/shared.js';
import type { Session } from '../auth/members-int-harness.js';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { HOST, ORIGIN } from '../support/auth-app.js';
import { blobExists, counts, download, png, uploadedId } from './att-harness.js';
import { buildZip, docxEntries } from './fixtures/zip-builder.js';

/** FR-OPS-09 보조(TRD §6-1-1 (5)·(6)): 문서·텍스트 다운로드 `attachment` 헤더, 파일명 헤더 주입 차단·정규화 순서, 90일 보존. */
let ctx: ConvIntContext | undefined;
const DAY = 24 * 60 * 60 * 1000;

afterEach(async () => {
  await teardownConvInt(ctx);
  ctx = undefined;
});

const PDF = Buffer.from('%PDF-1.7\n%%EOF\n', 'latin1');
const TEXT = Buffer.from('내용\n');
const DOCX = buildZip(docxEntries());

/** `encoded`는 X-Attachment-Filename 헤더 원값(이미 퍼센트 인코딩된 값). */
function docUpload(app: FastifyInstance, session: Session, conversationId: string, bytes: Buffer, encoded: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/attachments?conversation_id=${conversationId}`,
    headers: {
      host: HOST,
      origin: ORIGIN,
      cookie: `${SESSION_COOKIE}=${session.token}`,
      'x-csrf-token': session.csrf,
      'content-type': 'application/octet-stream',
      [ATTACHMENT_FILENAME_HEADER]: encoded,
    },
    payload: bytes,
  });
}

async function storedAs(app: FastifyInstance, session: Session, conversationId: string, bytes: Buffer, encoded: string): Promise<{ id: string; filename: string }> {
  const res = await docUpload(app, session, conversationId, bytes, encoded);
  expect(res.statusCode, `${encoded} ${res.body}`).toBe(201);
  const body = res.json<{ attachment_id: string; attachment: { filename: string } }>();
  return { id: body.attachment_id, filename: body.attachment.filename };
}

function assertNoInjection(res: LightMyRequestResponse): void {
  for (const [name, value] of Object.entries(res.headers)) {
    for (const v of Array.isArray(value) ? value : [String(value)]) expect(/[\r\n]/u.test(v), name).toBe(false);
  }
  expect(res.headers['set-cookie']).toBeUndefined();
}

describe('문서 다운로드 헤더·파일명(FR-OPS-09 보조)', () => {
  it('문서·텍스트는 attachment + RFC 6266/5987 파일명이고 미디어는 inline을 유지하며 나머지 보안 헤더는 같다', async () => {
    ctx = await setupConvInt();
    const c = ctx;
    const a = await as(c.app, 'a');
    const channel = await createChannel(c.app, a, 'dl');

    const cases: [Buffer, string, string, string][] = [
      [PDF, 'report.pdf', 'application/octet-stream', `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`],
      [TEXT, encodeURIComponent('메모.txt'), 'application/octet-stream', `attachment; filename="__.txt"; filename*=UTF-8''%EB%A9%94%EB%AA%A8.txt`],
      [
        DOCX,
        encodeURIComponent('보고서.DOCX'),
        // 사람 다운로드의 문서·텍스트는 octet-stream(실기 r3, TRD §6-1-1 (6)) — 본래 mime은 projection에 남는다.
        'application/octet-stream',
        `attachment; filename="___.docx"; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.docx`,
      ],
    ];
    for (const [bytes, encoded, type, disposition] of cases) {
      const { id } = await storedAs(c.app, a, channel, bytes, encoded);
      for (const range of [undefined, 'bytes=0-3']) {
        const res = await download(c.app, a, id, range === undefined ? {} : { range });
        expect(res.statusCode).toBe(range === undefined ? 200 : 206);
        expect(res.headers['content-disposition']).toBe(disposition);
        expect(res.headers['content-type']).toBe(type);
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
        expect(res.headers['cache-control']).toBe('no-store');
        assertNoInjection(res);
      }
    }
    const media = await uploadedId(c.app, a, channel, png(), 'image/png');
    const mediaRes = await download(c.app, a, media);
    expect(mediaRes.statusCode).toBe(200);
    expect(mediaRes.headers['content-disposition']).toBe('inline');
    expect(mediaRes.headers['content-type']).toBe('image/png');
  });

  it('파일명 헤더의 CR/LF·따옴표·세미콜론·퍼센트·RTLO는 응답 헤더에 주입되지 않는다', async () => {
    ctx = await setupConvInt();
    const c = ctx;
    const a = await as(c.app, 'a');
    const channel = await createChannel(c.app, a, 'inject');

    const cases: [string, string, string][] = [
      // CR/LF는 ④에서 제거 → 헤더 분할 없음.
      ['evil%0D%0ASet-Cookie:%20a=b.pdf', 'evilSet-Cookie: a=b.pdf', `attachment; filename="evilSet-Cookie: a=b.pdf"; filename*=UTF-8''evilSet-Cookie%3A%20a%3Db.pdf`],
      // `"` `;` `%`는 ASCII 대체에서 `_`, filename*에서는 %XX.
      ['a%22b%3B%25c.pdf', 'a"b;%c.pdf', `attachment; filename="a_b__c.pdf"; filename*=UTF-8''a%22b%3B%25c.pdf`],
      // RTLO(U+202E)는 ④에서 제거 → 표시상 확장자 위장 불가.
      ['invoice%E2%80%AEtxt.pdf', 'invoicetxt.pdf', `attachment; filename="invoicetxt.pdf"; filename*=UTF-8''invoicetxt.pdf`],
    ];
    for (const [encoded, filename, disposition] of cases) {
      const stored = await storedAs(c.app, a, channel, PDF, encoded);
      expect(stored.filename).toBe(filename);
      const res = await download(c.app, a, stored.id);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toBe(disposition);
      assertNoInjection(res);
    }
  });

  it('파일명 정규화는 TRD §6-1-1 (5) ①–⑦ 순서를 따르고 형식 오류 헤더는 400·저장 0이다', async () => {
    ctx = await setupConvInt();
    const c = ctx;
    const a = await as(c.app, 'a');
    const channel = await createChannel(c.app, a, 'norm');
    const suffix = '.txt';
    const maxStemChars = ATTACHMENT_FILENAME_MAX_CHARS - suffix.length;
    const hangulStemChars = Math.floor((ATTACHMENT_FILENAME_MAX_BYTES - suffix.length) / Buffer.byteLength('가'));

    const cases: [string, string][] = [
      // ① 디코드 뒤 ③ basename: 인코딩된 `/`·`\`도 경로로 보고 마지막 조각만.
      ['..%2F..%2Fetc%2Fpasswd.txt', 'passwd.txt'],
      ['C%3A%5Cdir%5Cnote.txt', 'note.txt'],
      // ② NFC: 조합형 e + U+0301 → U+00E9.
      ['e%CC%81.txt', 'é.txt'],
      // ④ 제어문자 제거가 ⑤ 앞뒤 공백·점 제거보다 먼저(RTLO가 앞에 있어도 공백·점이 지워진다).
      ['%E2%80%AE%20.report.txt.%20', 'report.txt'],
      // ⑥ 확장자는 판정 형식의 소문자 정규형.
      ['NOTE.TXT', 'NOTE.txt'],
      // ⑦ 줄기를 code point 경계에서 잘라 ≤ 200자·≤ 255바이트, 자른 끝의 공백·점은 다시 제거.
      [`${'a'.repeat(300)}${suffix}`, `${'a'.repeat(maxStemChars)}${suffix}`],
      [`${encodeURIComponent('가'.repeat(110))}${suffix}`, `${'가'.repeat(hangulStemChars)}${suffix}`],
      [`${'a'.repeat(maxStemChars - 1)}%20b${suffix}`, `${'a'.repeat(maxStemChars - 1)}${suffix}`],
    ];
    for (const [encoded, expected] of cases) {
      const stored = await storedAs(c.app, a, channel, TEXT, encoded);
      expect(stored.filename, encoded).toBe(expected);
      expect([...stored.filename].length).toBeLessThanOrEqual(ATTACHMENT_FILENAME_MAX_CHARS);
      expect(Buffer.byteLength(stored.filename)).toBeLessThanOrEqual(ATTACHMENT_FILENAME_MAX_BYTES);
    }
    const before = await counts(c.schema);
    // ① 실패: 잘못된 퍼센트 인코딩·잘못된 UTF-8·인코딩 값 상한 초과 → 400.
    for (const bad of ['a%2.txt', '%C3%28.txt', `${'a'.repeat(ATTACHMENT_FILENAME_HEADER_MAX_BYTES)}${suffix}`]) {
      expect((await docUpload(c.app, a, channel, TEXT, bad)).statusCode, bad.slice(0, 20)).toBe(400);
    }
    // 문서·텍스트인데 파일명 헤더가 없으면 400.
    const noName = await c.app.inject({
      method: 'POST',
      url: `/api/attachments?conversation_id=${channel}`,
      headers: { host: HOST, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${a.token}`, 'x-csrf-token': a.csrf, 'content-type': 'application/pdf' },
      payload: PDF,
    });
    expect(noName.statusCode).toBe(400);
    expect(await counts(c.schema)).toEqual(before);
  });

  it('문서·텍스트 보존은 90일: expires_at = 업로드 + 90일, 결속된 문서 바이트는 90일 경과 시 지워지고 메타는 남는다', async () => {
    let now = Date.now();
    ctx = await setupConvInt({ clock: () => now });
    const c = ctx;
    const a = await as(c.app, 'a');
    const channel = await createChannel(c.app, a, 'keep');
    const service = c.app.domainServices?.attachments;
    if (service === undefined) throw new Error('첨부 서비스 없음');

    const uploadedAt = now;
    const expiresAt = new Date(uploadedAt + ATTACHMENT_DOC_RETENTION_DAYS * DAY).toISOString();
    const ids: string[] = [];
    for (const [bytes, name] of [
      [PDF, 'keep.pdf'],
      [TEXT, 'keep.csv'],
    ] as const) {
      const res = await docUpload(c.app, a, channel, bytes, name);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ attachment: { expires_at: expiresAt, expired: false } });
      ids.push(res.json<{ attachment_id: string }>().attachment_id);
    }
    const sent = await req(c.app, 'POST', `/api/conversations/${channel}/messages`, a, { client_message_id: randomUUID(), body: '문서', attachment_ids: ids });
    expect(sent.statusCode).toBe(201);

    now = uploadedAt + ATTACHMENT_DOC_RETENTION_DAYS * DAY - 1000;
    await service.runRetention();
    for (const id of ids) expect(await blobExists(c.schema, id)).toBe(true);
    now = uploadedAt + ATTACHMENT_DOC_RETENTION_DAYS * DAY + 1000;
    await service.runRetention();
    for (const id of ids) expect(await blobExists(c.schema, id)).toBe(false);
    const meta = await c.schema.pool.query<{ deleted: boolean }>('SELECT deleted_at IS NOT NULL AS deleted FROM attachments WHERE id = ANY($1::uuid[])', [ids]);
    expect(meta.rows).toEqual([{ deleted: true }, { deleted: true }]);
  });
});
