import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { sendRaw } from './msg-int-harness.js';

let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const res = await ctx.schema.pool.query<{ n: string }>(sql, params);
  return Number(res.rows[0]?.n);
}

describe('멱등 전송', () => {
  it('FR-MSG-03 ACK 유실 후 같은 client_message_id·내용 3회는 메시지 1개이고 다른 내용은 409이며 다른 계정·대화와 결합되지 않는다', async () => {
    const a = await as(ctx.app, 'a');
    const b = await as(ctx.app, 'b');
    const general = await createChannel(ctx.app, a, 'general');
    const other = await createChannel(ctx.app, a, 'other');
    for (const id of [general, other]) await req(ctx.app, 'POST', `/api/conversations/${id}/join`, b);
    const created: number[] = [];
    ctx.app.messageEvents.on('created', (e) => created.push(e.changeId));
    const key = randomUUID();
    const payload = { client_message_id: key, body: '안녕\n세계', mention_user_ids: [ctx.ids.b] };

    // ACK 유실을 가정한 같은 키·같은 내용 3회: 첫 번째만 생성(201), 재시도는 원래 결과(200).
    const first = await sendRaw(ctx.app, a, general, payload);
    expect(first.statusCode).toBe(201);
    const original = first.json<{ message: { id: string }; seq: number; change_id: number }>();
    for (let i = 0; i < 2; i += 1) {
      const retry = await sendRaw(ctx.app, a, general, payload);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(first.json());
    }
    expect(await count('SELECT count(*) AS n FROM messages WHERE client_message_id = $1', [key])).toBe(1);
    expect(created).toEqual([original.change_id]);

    // 같은 키·다른 내용(본문, mention 집합, thread_root_id 각각)은 409, 저장 변화 0.
    const before = await count('SELECT count(*) AS n FROM conversation_changes');
    for (const changed of [{ body: '다른 내용' }, { mention_user_ids: [] }, { thread_root_id: original.message.id }]) {
      const conflict = await sendRaw(ctx.app, a, general, { ...payload, ...changed });
      expect(conflict.statusCode, JSON.stringify(changed)).toBe(409);
      expect(conflict.json<{ error: { code: string } }>().error.code).toBe('idempotency_conflict');
    }
    expect(await count('SELECT count(*) AS n FROM conversation_changes')).toBe(before);

    // 같은 키라도 다른 계정·다른 대화는 별개의 새 메시지다.
    expect((await sendRaw(ctx.app, b, general, { ...payload, body: 'B의 메시지' })).statusCode).toBe(201);
    expect((await sendRaw(ctx.app, a, other, { ...payload, body: '다른 대화' })).statusCode).toBe(201);
    expect(await count('SELECT count(*) AS n FROM messages WHERE client_message_id = $1', [key])).toBe(3);
    expect(created).toHaveLength(3);
  });

  it('동시 재시도(같은 키 10건 병렬)도 메시지 1개·seq 1개만 쓴다', async () => {
    const a = await as(ctx.app, 'a');
    const general = await createChannel(ctx.app, a, 'general');
    const payload = { client_message_id: randomUUID(), body: 'race' };
    const results = await Promise.all(Array.from({ length: 10 }, () => sendRaw(ctx.app, a, general, payload)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    expect(await count('SELECT count(*) AS n FROM messages')).toBe(1);
    expect(await count('SELECT last_seq AS n FROM conversations WHERE id = $1', [general])).toBe(1);
  });
});
