/**
 * action-timeout Codex r1 P1·P2: 헤더를 받은 뒤 본문 수신이 실패·지연될 때의 분류.
 * - 성공 상태 본문 실패 → NetworkError(시간 초과면 TimeoutError) — 응답을 확인하지 못했다.
 * - 오류 상태 본문 지연·실패 → 받은 상태의 HttpStatusError(코드 미상). 시간 초과는 헤더 수신 전에만 TimeoutError.
 * - 네트워크 결과 알림(onNetwork)은 요청당 최대 1회. 참고 출처: 일반 관념.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi, HttpStatusError, NetworkError, REQUEST_TIMEOUT_MS, TimeoutError, type FetchLike } from '../../src/data/api.js';
import { CONV, setup, U, type FakeServer } from '../sync/fake-server.js';

/** 헤더(상태)는 왔지만 본문이 끝나지 않는 응답. */
function stalledBody(status: number): Response {
  return new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), { status });
}

/** 헤더(상태)는 왔지만 본문 스트림이 중간에 끊기는 응답. */
function brokenBody(status: number): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"message":'));
        c.error(new TypeError('network connection lost'));
      },
    }),
    { status },
  );
}

const fixed =
  (make: () => Response): FetchLike =>
  () =>
    Promise.resolve(make());

describe('성공 상태 헤더 뒤 본문 실패(P1)', () => {
  it('본문 스트림이 끊기면 NetworkError — 원래 TypeError가 새지 않는다', async () => {
    const onNetwork = vi.fn();
    const api = createApi({ fetch: fixed(() => brokenBody(200)), onUnauthorized: () => undefined, onNetwork });
    const error = await api.del('/api/messages/m1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect(onNetwork.mock.calls).toEqual([[true]]);
  });

  it('메시지 삭제(attempt) → { status: network } 실패 결과(예외 아님)', async () => {
    const { ds } = setup({ fetch: fixed(() => brokenBody(200)) });
    expect(await ds.deleteMessage?.('m1')).toEqual({ ok: false, status: 'network' });
  });
});

describe('헤더 뒤 본문 지연·시간 초과(P1·P2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('성공 상태 본문이 상한을 넘으면 TimeoutError, 알림은 헤더 수신 1회(true)뿐', async () => {
    const onNetwork = vi.fn();
    const api = createApi({ fetch: fixed(() => stalledBody(200)), onUnauthorized: () => undefined, onNetwork });
    const result = api.del('/api/messages/m1').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await result).toBeInstanceOf(TimeoutError);
    expect(onNetwork.mock.calls).toEqual([[true]]);
  });

  it.each([400, 409])('%i 헤더 뒤 본문이 상한을 넘으면 그 상태의 HttpStatusError(코드 미상) — TimeoutError 아님', async (status) => {
    const onNetwork = vi.fn();
    const api = createApi({ fetch: fixed(() => stalledBody(status)), onUnauthorized: () => undefined, onNetwork });
    const result = api.post('/api/conversations/c1/messages', {}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    const error = await result;
    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error).not.toBeInstanceOf(NetworkError);
    expect((error as HttpStatusError).status).toBe(status);
    expect((error as HttpStatusError).code).toBeUndefined();
    expect(onNetwork.mock.calls).toEqual([[true]]);
  });

  it('409 헤더 뒤 본문이 끊겨도 HttpStatusError(409)', async () => {
    const api = createApi({ fetch: fixed(() => brokenBody(409)), onUnauthorized: () => undefined });
    const error = await api.post('/api/conversations/c1/messages', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect((error as HttpStatusError).status).toBe(409);
  });

  it('503 헤더 뒤 본문 지연·시간 초과 → onNetwork(false) 1회, 결과는 HttpStatusError(503)', async () => {
    const onNetwork = vi.fn();
    const api = createApi({ fetch: fixed(() => stalledBody(503)), onUnauthorized: () => undefined, onNetwork });
    const result = api.post('/api/conversations/c1/leave').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    const error = await result;
    expect(error).toBeInstanceOf(HttpStatusError);
    expect((error as HttpStatusError).status).toBe(503);
    expect(onNetwork.mock.calls).toEqual([[false]]);
  });

  it.each([
    [400, 'invalid'],
    [409, 'conflict'],
  ] as const)('메시지 전송 %i 헤더 뒤 본문 지연 → 기존 「다시 작성」 분류(%s)', async (status, reason) => {
    const holder: { server?: FakeServer } = {};
    const path = `/api/conversations/${CONV}/messages`;
    const fetch: FetchLike = (input, init) =>
      init?.method === 'POST' && new URL(input, 'https://oms.test').pathname === path
        ? Promise.resolve(stalledBody(status))
        : (holder.server as FakeServer).fetch(input, init);
    const env = setup({ fetch, newClientMessageId: () => U(900) });
    holder.server = env.server;
    await vi.advanceTimersByTimeAsync(0);
    const resumed = env.ds.resume();
    await vi.advanceTimersByTimeAsync(10);
    await resumed;
    env.ds.send({ conversationId: CONV }, '안녕');
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    const item = env.ds.getSnapshot().messages.find((m) => m.pending !== undefined);
    expect(item?.pending).toMatchObject({ status: 'failed', failure: 'rewrite', rewriteReason: reason });
  });
});
