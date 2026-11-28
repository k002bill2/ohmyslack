import { randomUUID } from 'node:crypto';
import { generateVAPIDKeys } from 'web-push';
import { describe, expect, it } from 'vitest';
import { createPushService, parsePushConfig, type PushSend, type PushStore } from '../../src/modules/push/index.js';
import type { MessageChange } from '../../src/modules/messages/events.js';

/** FR-CLIENT-05(TRD §6-2): 전송 직전 삭제 재확인(await) 중에도 같은 대화 60초 묶음은 1건을 지킨다. */
function created(conversationId: string, seq: number): MessageChange {
  return {
    changeId: seq,
    message: {
      id: randomUUID(), conversationId, threadRootId: null, seq, authorId: randomUUID(), authorKind: 'bot', mentionUserIds: [], deletedAt: null,
    },
  } as unknown as MessageChange;
}

describe('FR-CLIENT-05 push 묶음 — 삭제 재확인 경쟁', () => {
  it('같은 대화 메시지 2건이 병렬로 재확인 중이어도 같은 구독에는 1건만 보낸다', async () => {
    const keys = generateVAPIDKeys();
    const config = parsePushConfig(JSON.stringify({ public_key: keys.publicKey, private_key: keys.privateKey }), 'mailto:ops@example.test');
    if (config === undefined) throw new Error('VAPID 설정 생성 실패');
    const target = { id: randomUUID(), userId: randomUUID(), endpoint: 'https://web.push.apple.com/x', p256dh: 'p', auth: 'a' };
    const store = {
      context: () => Promise.resolve({ botDm: false, channel: true, rootAuthorId: null, rootAuthorKind: null }),
      targets: () => Promise.resolve([target]),
      isLive: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5)),
      markSuccess: () => Promise.resolve(),
      deleteById: () => Promise.resolve(),
    } as unknown as PushStore;
    let sent = 0;
    const send: PushSend = () => {
      sent += 1;
      return Promise.resolve(201);
    };
    const service = createPushService({ store, logger: { log: () => undefined }, clock: () => 0, config, send, schedule: (task) => task() });
    const conversationId = randomUUID();
    service.onMessageCreated(created(conversationId, 1));
    service.onMessageCreated(created(conversationId, 2));
    await service.idle();
    expect(sent).toBe(1);
  });
});
