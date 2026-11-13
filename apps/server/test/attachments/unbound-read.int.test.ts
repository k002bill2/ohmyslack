import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { download, png, uploadedId } from './att-harness.js';

/**
 * SR-D-04(보안 델타 리뷰): 미결속 첨부(메시지에 아직 붙지 않은 업로드)는 사람 경로에서도 업로더만 읽는다(봇 경로와 같은 규칙).
 * 같은 대화의 다른 멤버에게는 없는 첨부와 구별되지 않는 404. 결속 뒤에는 대화 read 규칙(TRD §6-1 권한)으로 멤버 200.
 */
let ctx: ConvIntContext | undefined;

afterEach(async () => {
  await teardownConvInt(ctx);
  ctx = undefined;
});

/** 요청마다 달라지는 값(request_id·날짜)을 뺀 응답 모양. */
function shape(res: LightMyRequestResponse): { status: number; body: unknown; headers: Record<string, unknown> } {
  const body = res.json<{ error: Record<string, unknown> }>();
  const error = Object.fromEntries(Object.entries(body.error).filter(([k]) => k !== 'request_id'));
  const headers = Object.fromEntries(Object.entries(res.headers).filter(([k]) => k !== 'date' && k !== 'x-request-id' && k !== 'request-id'));
  return { status: res.statusCode, body: { ...body, error }, headers };
}

describe('미결속 첨부 읽기(SR-D-04)', () => {
  it('FR-OPS-05 미결속 첨부는 업로더만 내려받고 같은 대화의 다른 멤버는 없는 첨부와 같은 404이며 결속 뒤에는 멤버도 200이다', async () => {
    ctx = await setupConvInt();
    const c = ctx;
    const a = await as(c.app, 'a');
    const b = await as(c.app, 'b');
    const channel = await createChannel(c.app, a, 'unbound');
    expect((await req(c.app, 'POST', `/api/conversations/${channel}/join`, b)).statusCode).toBe(200);
    const id = await uploadedId(c.app, a, channel, png(2, 3), 'image/png');

    expect((await download(c.app, a, id)).statusCode).toBe(200);
    const hidden = await download(c.app, b, id);
    const missing = await download(c.app, b, randomUUID());
    expect(hidden.statusCode).toBe(404);
    expect(shape(hidden)).toEqual(shape(missing));
    // Range 요청도 같은 404(바이트·길이 노출 0).
    expect(shape(await download(c.app, b, id, { range: 'bytes=0-7' }))).toEqual(shape(missing));

    const sent = await req(c.app, 'POST', `/api/conversations/${channel}/messages`, a, { client_message_id: randomUUID(), body: '사진', attachment_ids: [id] });
    expect(sent.statusCode).toBe(201);
    const bound = await download(c.app, b, id);
    expect(bound.statusCode).toBe(200);
    expect(bound.rawPayload.equals(png(2, 3))).toBe(true);
  });
});
