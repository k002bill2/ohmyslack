import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi, isUnreachable, NetworkError, REQUEST_TIMEOUT_MS, TimeoutError, type FetchLike } from '../../src/data/api.js';
import { failureText, isRetryable } from '../../src/features/spaces/failure.js';
import { failureView } from '../../src/features/conversation/MessageItemRules.js';
import { ERROR_COPY } from '../../src/ui/copy.js';

/** 응답하지 않는 fetch 대역 — signal이 abort되면 AbortError로 끝난다(브라우저 fetch와 같다). */
function hangingFetch(): { fetch: FetchLike; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  const fetch: FetchLike = (_path, init) => {
    calls.push(init ?? {});
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  };
  return { fetch, calls };
}

/** `delayMs` 뒤 200 JSON으로 응답하는 fetch 대역. */
function delayedFetch(delayMs: number): FetchLike {
  return () =>
    new Promise<Response>((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })), delayMs);
    });
}

describe('요청 시간 상한(action-timeout C1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('상한 값은 20초 상수 하나다', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(20_000);
  });

  it('상한을 넘으면 TimeoutError(NetworkError 하위)로 끝나고 fetch를 abort한다 — 자동 재전송 없음', async () => {
    const { fetch, calls } = hangingFetch();
    const onNetwork = vi.fn();
    const api = createApi({ fetch, onUnauthorized: () => undefined, onNetwork });
    const result = api.post('/api/conversations/c1/leave').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(calls[0]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toBeInstanceOf(NetworkError);
    expect(isUnreachable(error)).toBe(true);
    expect(calls[0]?.signal?.aborted).toBe(true);
    // 끊김 판정 알림은 1회(abort로 인한 fetch 거부를 중복으로 세지 않는다).
    expect(onNetwork.mock.calls).toEqual([[false]]);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 3);
    expect(calls).toHaveLength(1);
  });

  it('signal을 무시하는 fetch여도 상한에서 끝난다', async () => {
    const fetch: FetchLike = () => new Promise<Response>(() => undefined);
    const api = createApi({ fetch, onUnauthorized: () => undefined });
    const result = api.get('/api/conversations').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await result).toBeInstanceOf(TimeoutError);
  });

  it('상한 안 응답은 정상 결과', async () => {
    const api = createApi({ fetch: delayedFetch(REQUEST_TIMEOUT_MS - 1_000), onUnauthorized: () => undefined });
    const result = api.get<{ ok: number }>('/api/conversations');
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1_000);
    expect(await result).toEqual({ ok: 1 });
  });

  it('첨부 업로드(원시 바이트)는 상한에서 제외한다', async () => {
    const { fetch, calls } = hangingFetch();
    const api = createApi({ fetch, onUnauthorized: () => undefined });
    let settled = false;
    void api.upload('/api/attachments', new Blob(['x']), 'text/plain').finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 3);
    expect(settled).toBe(false);
    expect(calls[0]?.signal).toBeUndefined();
  });
});

describe('시간 초과 → 화면 문구(ERROR_COPY.timeout)', () => {
  it('설정 화면 동작 실패(failureText)', () => {
    expect(failureText({ status: 'network', timedOut: true })).toBe(ERROR_COPY.timeout);
    expect(failureText({ status: 'network' })).toBe(ERROR_COPY.network);
    expect(isRetryable({ status: 'network', timedOut: true })).toBe(true);
  });

  it('메시지 수정·삭제 실패(failureView)', () => {
    expect(failureView({ status: 'network', timedOut: true })).toEqual({ text: ERROR_COPY.timeout, retryable: true });
    expect(failureView({ status: 'network' })).toEqual({ text: ERROR_COPY.network, retryable: true });
  });
});

describe('DataSource 동작 결과(attempt)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('메시지 삭제가 상한을 넘으면 { status: network, timedOut: true } — 요청은 1회뿐', async () => {
    const { setup } = await import('../sync/fake-server.js');
    const { fetch, calls } = hangingFetch();
    vi.useFakeTimers();
    const { ds } = setup({ fetch });
    const result = ds.deleteMessage?.('m1');
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await result).toEqual({ ok: false, status: 'network', timedOut: true });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 3);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
});
