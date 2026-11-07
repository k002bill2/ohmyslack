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

function setup(online = true) {
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
  return { ctl, calls, pending, item: () => ctl.items()[0] as PendingMessage };
}

function view(item: PendingMessage, onRetry = vi.fn(), onDiscard = vi.fn()) {
  render(<MessageStatus item={item} onRetry={onRetry} onDiscard={onDiscard} />);
  return { onRetry, onDiscard };
}

const sending = createPending({ conversationId: CONV, authorId: ME, clientMessageId: 'cm-1', body: '안녕', online: true });
const key = { conversationId: CONV, authorId: ME, clientMessageId: 'cm-1' };

describe('FR-MSG-02 HTTP 저장 응답 전에는 저장 확인을 표시하지 않고 HTTP 오류는 실패와 재시도로 표시하며 연결 단절만으로 미저장을 단정하지 않고 자동 전송 큐를 만들지 않는다', () => {
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
    expect(screen.getByRole('status').textContent).toBe('저장 여부 확인 중 · 다시 시도');
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
    fireEvent.click((view(item()), screen.getByRole('button', { name: '저장 여부 확인 중 · 다시 시도' })));
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

  it('⑧ 자동 재전송 0회 — 네트워크 오류·HTTP 오류·WS 재연결 뒤에도 post 호출은 사용자 동작 횟수뿐', async () => {
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
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
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

  it('로컬 삭제는 목록에서 제거하고, 저장 확인 뒤의 늦은 오류는 상태를 되돌리지 않는다', () => {
    const { ctl } = setup();
    void ctl.submit(CONV, 'x');
    ctl.discard('cm-1');
    expect(ctl.items()).toHaveLength(0);
    const confirmed = transition(sending, { type: 'http-success', messageId: 'm' });
    expect(transition(confirmed, { type: 'network-error' })).toBe(confirmed);
    expect(transition(confirmed, { type: 'http-error', status: 500 })).toBe(confirmed);
    expect(transition(confirmed, { type: 'retry' })).toBe(confirmed);
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
