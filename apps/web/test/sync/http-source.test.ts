import { describe, expect, it } from 'vitest';
import { readCheckpoint, writeCheckpoint } from '../../src/features/sync';
import { CONV, ME, U, flush, message, setup } from './fake-server.js';

const relevant = (log: readonly string[]) =>
  log.filter((l) => /^(GET \/api\/me$|GET \/api\/sync|GET \/api\/conversations$|GET \/api\/conversations\?|ws conversation\.subscribe)/.test(l));

describe('HttpDataSource 복귀 순서(TRD §4)', () => {
  it('① 인증 → sync 페이지 catch-up → 목록 → 현재 대화 구독 순서, 완료 후 연결됨', async () => {
    const { server, ds, storage } = setup();
    writeCheckpoint(ME, 5, storage);
    server.on('GET /api/sync', (url) =>
      url.searchParams.get('through') === null
        ? { status: 200, body: { changes: [], through_cursor: 9, scanned_through: 7, has_more: true, next_cursor: 7 } }
        : { status: 200, body: { changes: [], through_cursor: 9, scanned_through: 9, has_more: false, next_cursor: 9 } },
    );
    ds.open?.(CONV);
    expect(await ds.resume()).toBe(true);
    expect(relevant(server.log)).toEqual([
      'GET /api/me',
      'GET /api/sync?after=5',
      'GET /api/sync?after=7&through=9',
      'GET /api/conversations',
      'ws conversation.subscribe',
    ]);
    expect(server.socket.sent.at(-1)).toEqual({ type: 'conversation.subscribe', conversation_id: CONV, after_cursor: 9 });
    expect(ds.getSnapshot().connection).toBe('connected');
    expect(readCheckpoint(ME, storage)).toBe(9);
  });

  it('구독 ACK 전에는 연결됨·checkpoint 전진이 없다', async () => {
    const { server, ds, storage } = setup();
    server.autoAck = false;
    writeCheckpoint(ME, 3, storage);
    ds.open?.(CONV);
    const done = ds.resume();
    await flush();
    await flush();
    expect(ds.getSnapshot().connection).toBe('catching-up');
    expect(readCheckpoint(ME, storage)).toBe(3);
    server.socket.push({ type: 'conversation.subscribed', conversation_id: CONV, through_cursor: 3 });
    expect(await done).toBe(true);
    expect(ds.getSnapshot().connection).toBe('connected');
  });
});

describe('멱등 병합·checkpoint', () => {
  it('② live/replay로 같은 change_id가 두 번 와도 1회만 반영, 낮은 change_id는 무시', async () => {
    const { server, ds, storage } = setup();
    writeCheckpoint(ME, 0, storage);
    ds.open?.(CONV);
    await ds.resume();
    const frame = { type: 'message.created', conversation_id: CONV, change_id: 11, message: message(1) };
    server.socket.push(frame);
    server.socket.push(frame);
    server.socket.push({ type: 'message.updated', conversation_id: CONV, change_id: 10, message: message(1, { body: 'old' }) });
    const msgs = ds.getSnapshot().messages.filter((m) => m.id === U(101));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.body).toBe('m1');
    expect(msgs[0]?.author).toBe('B');
    server.socket.push({ type: 'message.deleted', conversation_id: CONV, change_id: 12, message_id: U(101), seq: 1, deleted_at: 'x' });
    expect(ds.getSnapshot().messages.find((m) => m.id === U(101))).toMatchObject({ body: '', deleted: true });
  });

  it('③ live 이벤트는 checkpoint를 전진시키지 않는다(catch-up 완료 watermark에서만)', async () => {
    const { server, ds, storage } = setup();
    writeCheckpoint(ME, 4, storage);
    ds.open?.(CONV);
    await ds.resume();
    expect(readCheckpoint(ME, storage)).toBe(4);
    server.socket.push({ type: 'message.created', conversation_id: CONV, change_id: 50, message: message(2) });
    expect(readCheckpoint(ME, storage)).toBe(4);
  });

  it('⑦ 원문 projection의 root_reply_count가 오면 답글 수에 반영', async () => {
    const { server, ds, storage } = setup();
    writeCheckpoint(ME, 0, storage);
    ds.open?.(CONV);
    await ds.resume();
    server.socket.push({ type: 'message.created', conversation_id: CONV, change_id: 1, message: message(1) });
    server.socket.push({ type: 'message.created', conversation_id: CONV, change_id: 2, message: message(2, { thread_root_id: U(101), root_reply_count: null }) });
    expect(ds.getSnapshot().messages.find((m) => m.id === U(101))?.replyCount).toBe(0);
    server.socket.push({ type: 'message.updated', conversation_id: CONV, change_id: 3, message: message(1, { root_reply_count: 1 }) });
    expect(ds.getSnapshot().messages.find((m) => m.id === U(101))?.replyCount).toBe(1);
    expect(ds.getSnapshot().messages.find((m) => m.id === U(102))).toMatchObject({ rootId: U(101), replyCount: 0 });
  });
});

describe('401·410', () => {
  it('④ 401 → 화면 본문·checkpoint 삭제 후 세션 종료(S11)', async () => {
    const { server, ds, storage, ended } = setup();
    writeCheckpoint(ME, 0, storage);
    ds.open?.(CONV);
    await ds.resume();
    server.socket.push({ type: 'message.created', conversation_id: CONV, change_id: 1, message: message(1) });
    expect(ds.getSnapshot().messages).toHaveLength(1);
    server.on('GET /api/me', () => ({ status: 401 }));
    expect(await ds.resume()).toBe(false);
    expect(ds.getSnapshot().messages).toHaveLength(0);
    expect(ds.getSnapshot().spaces).toHaveLength(0);
    expect(readCheckpoint(ME, storage)).toBeNull();
    expect(storage.length).toBe(0);
    expect(ended).toEqual(['unauthorized']);
  });

  it('⑤ 410 → snapshot 절차(목록 → snapshot → snapshot_cursor부터 catch-up), 완료 전 최신 표시 없음', async () => {
    const { server, ds, storage } = setup();
    writeCheckpoint(ME, 1, storage);
    server.on('GET /api/sync', (url) =>
      url.searchParams.get('after') === '1'
        ? { status: 410 }
        : { status: 200, body: { changes: [], through_cursor: 40, scanned_through: 40, has_more: false, next_cursor: 40 } },
    );
    let seenDuring: string | null = null;
    server.on('GET /api/sync/snapshot', () => {
      seenDuring = ds.getSnapshot().connection;
      return { status: 200, body: { snapshot_cursor: 30, conversation_id: CONV, messages: [message(1)], has_more: false, next_before_seq: null } };
    });
    ds.open?.(CONV);
    expect(await ds.resume()).toBe(true);
    expect(seenDuring).toBe('catching-up');
    expect(relevant(server.log)).toEqual([
      'GET /api/me',
      'GET /api/sync?after=1',
      'GET /api/conversations',
      `GET /api/sync/snapshot?conversation_id=${CONV}`,
      'GET /api/sync?after=30',
      'GET /api/conversations',
      'ws conversation.subscribe',
    ]);
    expect(readCheckpoint(ME, storage)).toBe(40);
    expect(ds.getSnapshot().messages.map((m) => m.body)).toEqual(['m1']);
  });

  it('checkpoint 없는 새 기기도 snapshot 절차로 초기화한다', async () => {
    const { server, ds, storage } = setup();
    expect(await ds.resume()).toBe(true);
    expect(server.log).toContain(`GET /api/sync/snapshot?conversation_id=${CONV}`);
    expect(readCheckpoint(ME, storage)).toBe(0);
  });
});

describe('⑥ 전송 실패·재시도(W-10a FSM 재사용)', () => {
  it('5xx → 실패(다시 시도 가능) → 재시도 성공 시 저장 확인, CSRF 헤더 포함', async () => {
    const { server, ds, storage } = setup({ newClientMessageId: () => U(900) });
    writeCheckpoint(ME, 0, storage);
    await ds.resume();
    const headers: (string | null)[] = [];
    let fail = true;
    server.on(`POST /api/conversations/${CONV}/messages`, (_url, init) => {
      headers.push(new Headers(init?.headers).get('X-CSRF-Token'));
      if (fail) return { status: 503 };
      return { status: 201, body: { message: message(7, { author_id: ME, client_message_id: U(900) }), seq: 7, change_id: 70, mention_user_ids: [] } };
    });
    ds.send({ conversationId: CONV }, '안녕');
    await flush();
    const failed = ds.getSnapshot().messages.find((m) => m.pending !== undefined);
    expect(failed?.pending).toMatchObject({ status: 'failed', failure: 'retryable' });
    fail = false;
    await ds.retry(U(900));
    expect(ds.getSnapshot().messages.filter((m) => m.pending !== undefined)).toHaveLength(0);
    expect(ds.getSnapshot().messages.find((m) => m.id === U(107))?.author).toBe('A');
    expect(headers).toEqual(['csrf-1', 'csrf-1']);
  });

  it('네트워크 오류 → 저장 여부 확인 중, 답글은 thread_root_id를 보낸다', async () => {
    const { server, ds, storage } = setup({ newClientMessageId: () => U(901) });
    writeCheckpoint(ME, 0, storage);
    await ds.resume();
    const bodies: unknown[] = [];
    server.on(`POST /api/conversations/${CONV}/messages`, (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return 'network';
    });
    ds.send({ conversationId: CONV, rootId: U(101) }, '답');
    await flush();
    expect(bodies).toEqual([{ client_message_id: U(901), body: '답', thread_root_id: U(101) }]);
    const item = ds.getSnapshot().messages.find((m) => m.pending !== undefined);
    expect(item).toMatchObject({ rootId: U(101), pending: { status: 'unknown' } });
    ds.discard(U(901));
    expect(ds.getSnapshot().messages.filter((m) => m.pending !== undefined)).toHaveLength(0);
  });
});
