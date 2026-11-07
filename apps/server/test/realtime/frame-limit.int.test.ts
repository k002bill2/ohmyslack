import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WS_FRAME_MAX_BYTES } from '../../src/shared.js';
import { as, convState, createChannel, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { closeAll, connected, freePort, listen, type WsClient } from './ws-int-harness.js';

/** TR-SEC-06 WS frame 크기 경계(TRD §5 64 KiB)와 스키마 밖 frame 거절. */
let ctx: ConvIntContext;
let base: string;

const clients: WsClient[] = [];

beforeEach(async () => {
  const port = await freePort();
  ctx = await setupConvInt({ extraHosts: [`127.0.0.1:${port}`] });
  base = await listen(ctx.app, port);
});

afterEach(async () => {
  closeAll(clients.splice(0));
  await teardownConvInt(ctx);
});

/** 정확히 bytes 바이트가 되도록 공백으로 채운 subscribe frame. */
function paddedSubscribe(conversationId: string, bytes: number): string {
  const core = JSON.stringify({ type: 'conversation.subscribe', conversation_id: conversationId, after_cursor: 0 });
  return core.slice(0, -1) + ' '.repeat(bytes - Buffer.byteLength(core)) + '}';
}

async function messageCount(): Promise<number> {
  const res = await ctx.schema.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM messages');
  return res.rows[0]?.n ?? -1;
}

describe('WS frame 경계', () => {
  it('TR-SEC-06 WS frame은 TRD 상한에서 처리되고 상한+1 바이트는 저장 없이 거절된다', async () => {
    const a = await as(ctx.app, 'a');
    const cid = await createChannel(ctx.app, a, 'general');
    const before = { state: await convState(ctx.schema), messages: await messageCount() };
    const client = await connected(base, { token: a.token });
    clients.push(client);

    const atLimit = paddedSubscribe(cid, WS_FRAME_MAX_BYTES);
    expect(Buffer.byteLength(atLimit)).toBe(WS_FRAME_MAX_BYTES);
    client.sendRaw(atLimit);
    const ack = await client.waitFor((f) => f.type === 'conversation.subscribed');
    expect(ack).toMatchObject({ type: 'conversation.subscribed', conversation_id: cid });

    const overLimit = paddedSubscribe(cid, WS_FRAME_MAX_BYTES + 1);
    expect(Buffer.byteLength(overLimit)).toBe(WS_FRAME_MAX_BYTES + 1);
    const framesBefore = client.frames.length;
    client.sendRaw(overLimit);
    const { code } = await client.closed;
    expect(code).toBe(1009);
    expect(client.frames.length).toBe(framesBefore);
    expect({ state: await convState(ctx.schema), messages: await messageCount() }).toEqual(before);
  });

  it('스키마 밖 frame·JSON 아님은 error{code,retryable}로 거절되고 연결은 유지된다', async () => {
    const a = await as(ctx.app, 'a');
    const cid = await createChannel(ctx.app, a, 'general');
    const client = await connected(base, { token: a.token });
    clients.push(client);
    client.sendRaw('not json');
    client.send({ type: 'message.create', conversation_id: cid, body: 'x' });
    client.send({ type: 'conversation.subscribe', conversation_id: 'not-a-uuid', after_cursor: 0 });
    client.send({ type: 'conversation.subscribe', conversation_id: cid, after_cursor: -1 });
    await client.waitFor(() => client.frames.length >= 4);
    expect(client.frames).toEqual(Array(4).fill({ type: 'error', code: 'invalid_frame', retryable: false }));
    client.send({ type: 'conversation.subscribe', conversation_id: cid, after_cursor: 0 });
    await client.waitFor((f) => f.type === 'conversation.subscribed');
    expect(await messageCount()).toBe(0);
    client.close();
  });
});
