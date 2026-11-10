import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/http/errors.js';
import { assertReplyRootVisible } from '../../src/modules/bots/routes.js';

/** 봇 답글 루트 가시성 판정(BOT_CHANNEL_SPEC §4-5 쓰기 차단). DB 없이 visibleMessageIds 페이크로. */
const BOT = '00000000-0000-4000-8000-000000000001';

function fakeBots(visible: readonly string[]) {
  const calls: { botId: string; ids: readonly string[] }[] = [];
  const bots = {
    visibleMessageIds: async (botId: string, ids: readonly string[]) => {
      calls.push({ botId, ids });
      return new Set(ids.filter((id) => visible.includes(id)));
    },
  };
  return { bots, calls };
}

const body = (extra: Record<string, unknown> = {}) => ({ client_message_id: randomUUID(), body: 'hi', ...extra });

describe('봇 답글 루트 가시성 판정', () => {
  it('thread_root_id가 없거나 null이거나 본문 형식이 틀리면 조회 없이 통과한다(형식 오류는 sendAs의 400)', async () => {
    const { bots, calls } = fakeBots([]);
    await assertReplyRootVisible(bots, BOT, body());
    await assertReplyRootVisible(bots, BOT, body({ thread_root_id: null }));
    await assertReplyRootVisible(bots, BOT, body({ thread_root_id: 'not-a-uuid' }));
    await assertReplyRootVisible(bots, BOT, undefined);
    expect(calls).toEqual([]);
  });

  it('보이는 루트는 통과하고, 대문자 UUID도 소문자로 판정한다', async () => {
    const root = randomUUID();
    const { bots, calls } = fakeBots([root]);
    await assertReplyRootVisible(bots, BOT, body({ thread_root_id: root.toUpperCase() }));
    expect(calls).toEqual([{ botId: BOT, ids: [root] }]);
  });

  it('보이지 않는 루트(숨김·없음)는 404 not_found', async () => {
    const { bots } = fakeBots([]);
    const err = await assertReplyRootVisible(bots, BOT, body({ thread_root_id: randomUUID() })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ statusCode: 404, code: 'not_found' });
  });
});
