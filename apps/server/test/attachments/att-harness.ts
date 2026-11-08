import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import type { Session } from '../auth/members-int-harness.js';
import { HOST, ORIGIN } from '../support/auth-app.js';
import type { TestSchema } from '../support/test-db.js';

/** 첨부 테스트 공통: 최소 유효 헤더만 가진 형식별 바이트와 업로드·다운로드 호출. */
export function png(width = 2, height = 3, pad = 0): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(pad, 0x41)]);
}

export function jpeg(width = 5, height = 4): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

export function webp(width = 7, height = 6): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

/** ID3v2(빈 태그) + MPEG1 Layer III 128kbps 44.1kHz 프레임 헤더 + 채움. CBR 근사 길이 = 오디오 바이트×8/128. */
export function mp3(audioBytes = 16_000): Buffer {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const audio = Buffer.alloc(audioBytes, 0x00);
  Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(audio, 0);
  return Buffer.concat([id3, audio]);
}

export const HTML = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');
export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');

function authHeaders(session: Session): Record<string, string> {
  return { host: HOST, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${session.token}`, 'x-csrf-token': session.csrf };
}

export function upload(app: FastifyInstance, session: Session, conversationId: string, bytes: Buffer, contentType: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/attachments?conversation_id=${conversationId}`,
    headers: { ...authHeaders(session), 'content-type': contentType },
    payload: bytes,
  });
}

export function download(app: FastifyInstance, session: Session, id: string, extra: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: `/api/attachments/${id}`, headers: { ...authHeaders(session), ...extra } });
}

export async function uploadedId(app: FastifyInstance, session: Session, conversationId: string, bytes: Buffer, contentType: string): Promise<string> {
  const res = await upload(app, session, conversationId, bytes, contentType);
  if (res.statusCode !== 201) throw new Error(`업로드 실패: ${res.statusCode} ${res.body}`);
  return res.json<{ attachment_id: string }>().attachment_id;
}

export async function counts(schema: TestSchema): Promise<{ meta: number; blobs: number }> {
  const meta = await schema.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM attachments');
  const blobs = await schema.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM attachment_blobs');
  return { meta: Number(meta.rows[0]?.n), blobs: Number(blobs.rows[0]?.n) };
}

export async function blobExists(schema: TestSchema, id: string): Promise<boolean> {
  return ((await schema.pool.query('SELECT 1 FROM attachment_blobs WHERE attachment_id = $1', [id])).rowCount ?? 0) > 0;
}
