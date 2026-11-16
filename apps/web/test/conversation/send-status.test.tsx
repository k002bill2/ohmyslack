import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  MessageStatus,
  createPending,
  createSendController,
  transition,
  type PendingMessage,
  type PostRequest,
  type PostResult,
} from '../../src/features/conversation/index.js';

afterEach(cleanup);

const ME = 'user-me';
const CONV = 'conv-1';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(initialOnline = true) {
  let online = initialOnline;
  const calls: PostRequest[] = [];
  const pending: ReturnType<typeof deferred<PostResult>>[] = [];
  let seq = 0;
  const ctl = createSendController({
    me: ME,
    post: (req) => {
      calls.push(req);
      const d = deferred<PostResult>();
      pending.push(d);
      return d.promise;
    },
    newClientMessageId: () => `cm-${++seq}`,
    isOnline: () => online,
    onChange: () => undefined,
  });
  const setOnline = (v: boolean) => {
    online = v;
  };
  return { ctl, calls, pending, setOnline, item: () => ctl.items()[0] as PendingMessage };
}

function view(item: PendingMessage, onRetry = vi.fn(), onDiscard = vi.fn()) {
  render(<MessageStatus item={item} onRetry={onRetry} onDiscard={onDiscard} />);
  return { onRetry, onDiscard };
}

const sending = createPending({ conversationId: CONV, authorId: ME, clientMessageId: 'cm-1', body: '안녕', online: true });
const key = { conversationId: CONV, authorId: ME, clientMessageId: 'cm-1' };

describe('FR-MSG-02 세부 사례(UI_STATES §7 ①–⑨)', () => {
  it('① 2xx 전에는 저장 확인을 표시하지 않고 「전송 중」, 2xx 후 저장 확인(표시 없음)', async () => {
    const { ctl, pending, item } = setup();
    const done = ctl.submit(CONV, '안녕');
    expect(item().status).toBe('sending');
    view(item());
    expect(screen.getByLabelText('전송 중').textContent).toBe('전송 중');
    cleanup();
    pending[0]?.resolve({ ok: true, messageId: 'm-1' });
    await done;
    expect(item()).toMatchObject({ status: 'confirmed', messageId: 'm-1' });
    const { container } = render(<MessageStatus item={item()} onRetry={vi.fn()} onDiscard={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it.each([500, 503, 403, 429])('② HTTP %i → 「전송 실패 · 다시 시도」 + 「삭제」, role=alert', async (status) => {
    const { ctl, pending, item } = setup();
    const done = ctl.submit(CONV, '안녕');
    pending[0]?.resolve({ ok: false, status });
    await done;
    expect(item()).toMatchObject({ status: 'failed', failure: 'retryable' });
    const { onRetry, onDiscard } = view(item());
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('msg-failed');
    fireEvent.click(screen.getByRole('button', { name: '전송 실패 · 다시 시도' }));
    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it.each([400, 409])('② HTTP %i → 실패, 다시 시도 대신 「다시 작성」 안내', async (status) => {
    const { ctl, pending, item, calls } = setup();
    const done = ctl.submit(CONV, '안녕');
    pending[0]?.resolve({ ok: false, status });
    await done;
    expect(item()).toMatchObject({ status: 'failed', failure: 'rewrite' });
    view(item());
    expect(screen.getByRole('alert').textContent).toContain('다시 작성');
    expect(screen.queryByRole('button', { name: '전송 실패 · 다시 시도' })).toBeNull();
    await ctl.retry('cm-1');
    expect(calls).toHaveLength(1);
  });

  it('③ 응답 없는 네트워크 오류·타임아웃 → 「저장 여부 확인 중 · 다시 시도」(실패 아님, role=status)', async () => {
    const { ctl, pending, item } = setup();
    const done = ctl.submit(CONV, '안녕');
    pending[0]?.reject(new TypeError('Failed to fetch'));
    await done;
    expect(item().status).toBe('unknown');
    view(item());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('저장 여부 확인 중다시 시도목록에서 지우기');
    expect(screen.getByRole('button', { name: '저장 여부 확인 중 · 다시 시도' }).textContent).toBe('다시 시도');
  });

  it('④ 「저장 여부 확인 중」은 대응 키가 같은 message.created로 저장 확인으로 자동 해소', async () => {
    const { ctl, pending, item } = setup();
    const done = ctl.submit(CONV, '안녕');
    pending[0]?.reject(new Error('timeout'));
    await done;
    ctl.messageCreated(key, 'm-9');
    expect(item()).toMatchObject({ status: 'confirmed', messageId: 'm-9' });
  });

  it('⑤ 다른 author_id·다른 대화의 같은 client_message_id는 해소하지 않음', () => {
    const unknown = transition(sending, { type: 'network-error' });
    expect(unknown.status).toBe('unknown');
    const other = [
      { ...key, authorId: 'user-other' },
      { ...key, conversationId: 'conv-2' },
      { ...key, clientMessageId: 'cm-2' },
    ];
    for (const k of other) {
      expect(transition(unknown, { type: 'message-created', key: k, messageId: 'x' }).status).toBe('unknown');
    }
  });

  it('⑥ WS close로 저장 확인 항목(및 다른 상태)이 바뀌지 않음', async () => {
    const { ctl, pending, item } = setup();
    const done = ctl.submit(CONV, '안녕');
    pending[0]?.resolve({ ok: true, messageId: 'm-1' });
    await done;
    ctl.wsClosed();
    expect(item().status).toBe('confirmed');
    for (const s of [sending, transition(sending, { type: 'network-error' })]) {
      expect(transition(s, { type: 'ws-closed' })).toBe(s);
    }
  });

  it('⑦ 재시도 요청은 같은 client_message_id·같은 본문', async () => {
    const { ctl, pending, calls, item } = setup();
    const first = ctl.submit(CONV, '같은 본문');
    pending[0]?.reject(new Error('network'));
    await first;
    view(item());
    fireEvent.click(screen.getByRole('button', { name: '저장 여부 확인 중 · 다시 시도' }));
    const retry = ctl.retry('cm-1');
    expect(item().status).toBe('sending');
    pending[1]?.resolve({ ok: true, messageId: 'm-1' });
    await retry;
    expect(calls).toEqual([
      { conversationId: CONV, clientMessageId: 'cm-1', body: '같은 본문' },
      { conversationId: CONV, clientMessageId: 'cm-1', body: '같은 본문' },
    ]);
    expect(item().status).toBe('confirmed');
  });

  it('⑧ 온라인 상태의 실패는 자동 재전송 0회 — 네트워크 오류·HTTP 오류·WS 재연결 뒤에도 post 호출은 사용자 동작 횟수뿐', async () => {
    vi.useFakeTimers();
    try {
      const { ctl, pending, calls } = setup();
      const a = ctl.submit(CONV, 'a');
      const b = ctl.submit(CONV, 'b');
      pending[0]?.reject(new Error('network'));
      pending[1]?.resolve({ ok: false, status: 503 });
      await Promise.all([a, b]);
      ctl.wsClosed();
      await vi.advanceTimersByTimeAsync(60_000);
      await ctl.resendOffline();
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⑨ 오프라인으로 못 보낸 메시지는 온라인 복귀 때 같은 ID로 순서대로 한 번 다시 보낸다(2026-11-17 결정)', async () => {
    const { ctl, calls, pending, setOnline } = setup(false);
    await ctl.submit(CONV, '하나');
    await ctl.submit(CONV, '둘');
    expect(calls).toHaveLength(0);
    setOnline(true);
    const resend = ctl.resendOffline();
    await Promise.resolve();
    expect(calls.map((c) => c.clientMessageId)).toEqual(['cm-1']);
    pending[0]?.resolve({ ok: true, messageId: 'm-1' });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    pending[1]?.resolve({ ok: true, messageId: 'm-2' });
    await resend;
    expect(calls).toEqual([
      { conversationId: CONV, clientMessageId: 'cm-1', body: '하나' },
      { conversationId: CONV, clientMessageId: 'cm-2', body: '둘' },
    ]);
    expect(ctl.items().map((it) => it.status)).toEqual(['confirmed', 'confirmed']);
  });

  it('⑨ 오프라인 중 네트워크 오류·오프라인 재시도도 대상이고, 재전송이 다시 실패해도 같은 복귀에서 반복하지 않는다', async () => {
    const { ctl, calls, pending, setOnline, item } = setup();
    const first = ctl.submit(CONV, 'x');
    setOnline(false);
    pending[0]?.reject(new TypeError('Failed to fetch'));
    await first;
    expect(item()).toMatchObject({ status: 'unknown', offline: true });
    setOnline(true);
    const r1 = ctl.resendOffline();
    await Promise.resolve();
    pending[1]?.reject(new TypeError('Failed to fetch'));
    await r1;
    expect(item()).toMatchObject({ status: 'unknown' });
    expect(item().offline).toBeUndefined();
    await ctl.resendOffline();
    expect(calls).toHaveLength(2);
    setOnline(false);
    await ctl.retry('cm-1');
    expect(item()).toMatchObject({ status: 'failed', offline: true });
    setOnline(true);
    const r2 = ctl.resendOffline();
    await Promise.resolve();
    pending[2]?.resolve({ ok: true, messageId: 'm-1' });
    await r2;
    expect(calls.map((c) => c.clientMessageId)).toEqual(['cm-1', 'cm-1', 'cm-1']);
  });

  it('⑨ 온라인 복귀 전에 삭제한 항목·400/409·아직 오프라인이면 보내지 않는다', async () => {
    const { ctl, calls, pending, setOnline } = setup();
    const bad = ctl.submit(CONV, 'bad');
    pending[0]?.resolve({ ok: false, status: 400 });
    await bad;
    setOnline(false);
    await ctl.submit(CONV, 'gone');
    await ctl.submit(CONV, 'later');
    ctl.discard('cm-2');
    await ctl.resendOffline();
    expect(calls).toHaveLength(1);
    setOnline(true);
    const r = ctl.resendOffline();
    await Promise.resolve();
    pending[1]?.resolve({ ok: true, messageId: 'm-3' });
    await r;
    expect(calls.map((c) => c.clientMessageId)).toEqual(['cm-1', 'cm-3']);
  });

  it('⑨ 재전송 중 다시 끊겼다 복귀해도 앞 응답 전에 다음 항목을 보내지 않는다(Codex r1 P2)', async () => {
    const { ctl, calls, pending, setOnline } = setup(false);
    await ctl.submit(CONV, '하나');
    await ctl.submit(CONV, '둘');
    setOnline(true);
    const r1 = ctl.resendOffline();
    await Promise.resolve();
    const r2 = ctl.resendOffline();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.map((c) => c.clientMessageId)).toEqual(['cm-1']);
    pending[0]?.resolve({ ok: true, messageId: 'm-1' });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    pending[1]?.resolve({ ok: true, messageId: 'm-2' });
    await Promise.all([r1, r2]);
    expect(calls.map((c) => c.clientMessageId)).toEqual(['cm-1', 'cm-2']);
  });

  it('⑨ reset(세션 종료) 뒤에는 진행 중이던 재전송 루프가 남은 항목을 보내지 않는다(Codex r1 P2)', async () => {
    const { ctl, calls, pending, setOnline } = setup(false);
    await ctl.submit(CONV, '하나');
    await ctl.submit(CONV, '둘');
    setOnline(true);
    const r = ctl.resendOffline();
    await Promise.resolve();
    ctl.reset();
    pending[0]?.resolve({ ok: true, messageId: 'm-1' });
    await r;
    expect(calls).toHaveLength(1);
    expect(ctl.items()).toHaveLength(0);
  });

  it('전이 6: 전송 중 message.created가 먼저 와도 HTTP를 기다리고, 항목은 1개, 이후 응답 없이 끝나면 저장 확인', async () => {
    const { ctl, pending, item } = setup();
    const done = ctl.submit(CONV, '안녕');
    ctl.messageCreated(key, 'm-1');
    expect(ctl.items()).toHaveLength(1);
    expect(item()).toMatchObject({ status: 'sending', serverEventSeen: true });
    pending[0]?.reject(new Error('network'));
    await done;
    expect(item().status).toBe('confirmed');
  });

  it('전이 5: HTTP 2xx 뒤 같은 message.created가 와도 항목 1개·상태 유지', async () => {
    const { ctl, pending, item } = setup();
    const done = ctl.submit(CONV, '안녕');
    pending[0]?.resolve({ ok: true, messageId: 'm-1' });
    await done;
    ctl.messageCreated(key, 'm-1');
    expect(ctl.items()).toHaveLength(1);
    expect(item().status).toBe('confirmed');
  });

  it('전송 시점 navigator.onLine === false → HTTP 미호출, 즉시 실패(다시 시도 가능)', async () => {
    const { ctl, calls, item } = setup(false);
    await ctl.submit(CONV, '오프라인');
    expect(calls).toHaveLength(0);
    expect(item()).toMatchObject({ status: 'failed', failure: 'retryable' });
  });

  it('오프라인에서 다시 시도하면 HTTP를 보내지 않고 실패를 유지하며, 복구 뒤 재시도는 같은 ID로 1회 보낸다', async () => {
    const { ctl, calls, pending, setOnline, item } = setup(false);
    await ctl.submit(CONV, '오프라인');
    await ctl.retry('cm-1');
    expect(calls).toHaveLength(0);
    expect(item()).toMatchObject({ status: 'failed', failure: 'retryable' });
    setOnline(true);
    const r = ctl.retry('cm-1');
    pending[0]?.reject(new Error('network'));
    await r;
    expect(item().status).toBe('unknown');
    setOnline(false);
    await ctl.retry('cm-1');
    expect(item()).toMatchObject({ status: 'failed', failure: 'retryable' });
    expect(calls).toHaveLength(1);
  });

  it('로컬 삭제는 목록에서 제거하고, 저장 확인 뒤의 늦은 오류는 상태를 되돌리지 않는다', () => {
    const { ctl } = setup();
    void ctl.submit(CONV, 'x');
    ctl.discard('cm-1');
    expect(ctl.items()).toHaveLength(0);
    const confirmed = transition(sending, { type: 'http-success', messageId: 'm' });
    expect(transition(confirmed, { type: 'network-error' })).toBe(confirmed);
    expect(transition(confirmed, { type: 'http-error', status: 500 })).toBe(confirmed);
    expect(transition(confirmed, { type: 'retry' })).toBe(confirmed);
    expect(transition(confirmed, { type: 'offline-retry' })).toBe(confirmed);
    expect(transition(confirmed, { type: 'http-success', messageId: 'z' })).toBe(confirmed);
  });

  it('재시도 중복 호출·없는 항목 재시도는 요청을 보내지 않는다', async () => {
    const { ctl, pending, calls } = setup();
    void ctl.submit(CONV, 'x');
    await ctl.retry('cm-1');
    await ctl.retry('missing');
    expect(calls).toHaveLength(1);
    pending[0]?.resolve({ ok: true, messageId: 'm' });
  });
});

it('FR-MSG-02 HTTP 저장 응답 전에는 저장 확인을 표시하지 않고 HTTP 오류는 실패와 재시도로 표시하며 연결 단절만으로 미저장을 단정하지 않고 지속 전송 큐 없이 오프라인으로 못 보낸 메시지만 복귀 때 한 번 다시 보낸다', async () => {
  const { ctl, pending, calls } = setup();
  const a = ctl.submit(CONV, 'a');
  expect(ctl.items()[0]?.status).toBe('sending');
  const b = ctl.submit(CONV, 'b');
  const c = ctl.submit(CONV, 'c');
  pending[0]?.resolve({ ok: true, messageId: 'm-1' });
  pending[1]?.resolve({ ok: false, status: 500 });
  pending[2]?.reject(new TypeError('Failed to fetch'));
  await Promise.all([a, b, c]);
  expect(ctl.items().map((it) => it.status)).toEqual(['confirmed', 'failed', 'unknown']);
  ctl.wsClosed();
  expect(ctl.items().map((it) => it.status)).toEqual(['confirmed', 'failed', 'unknown']);
  expect(calls).toHaveLength(3);
  ctl.messageCreated({ conversationId: CONV, authorId: 'user-other', clientMessageId: 'cm-3' }, 'x');
  expect(ctl.items()[2]?.status).toBe('unknown');
  ctl.messageCreated({ conversationId: CONV, authorId: ME, clientMessageId: 'cm-3' }, 'm-3');
  expect(ctl.items()[2]?.status).toBe('confirmed');
  view(ctl.items()[1] as PendingMessage);
  expect(screen.getByRole('alert').textContent).toContain('전송 실패');
    expect(screen.getByRole('button', { name: '전송 실패 · 다시 시도' }).textContent).toBe('다시 시도');
});
