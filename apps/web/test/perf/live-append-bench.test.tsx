/**
 * W-10k 관측 C 마이크로벤치(jsdom): 대화 메시지 N개가 화면에 있을 때 WS `message.created` 1건의
 * ① fold+emit(데이터 소스) ② React 커밋까지(act 동기 반영) 시간을 잰다. 수치는 REPORT 근거용 — 판정은 넉넉한 상한만.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource, type HttpDataSource } from '../../src/data/http-source.js';
import { CONV, FakeServer, MemoryStorage, flush, message } from '../sync/fake-server.js';

afterEach(cleanup);

const RUNS = 15;
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};
const median = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;

async function bench(n: number) {
  window.history.replaceState(null, '', '/');
  const server = new FakeServer();
  const history = Array.from({ length: n }, (_, i) => message(i + 1, { body: `메시지 ${i + 1} https://example.com/${i} 본문` }));
  server.on(`GET /api/conversations/${CONV}/messages`, () => ({ status: 200, body: { messages: history, has_more: false } }));
  let ds: HttpDataSource | undefined;
  render(
    <LiveApp
      fetch={server.fetch}
      createSource={(deps) => {
        ds = createHttpDataSource({
          ...deps,
          wsUrl: 'wss://oms.test/api/ws',
          createSocket: server.createSocket,
          storage: new MemoryStorage(),
          isOnline: () => true,
          setTimer: () => 0,
          clearTimer: () => undefined,
        });
        return ds;
      }}
    />,
  );
  await settle();
  fireEvent.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: 'general' }));
  await settle();
  expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(n);
  const emitMs: number[] = [];
  const commitMs: number[] = [];
  let emitted = 0;
  ds?.subscribe(() => {
    emitted = performance.now();
  });
  for (let k = 0; k < RUNS; k += 1) {
    const seq = n + 1 + k;
    const frame = { type: 'message.created', change_id: seq, conversation_id: CONV, message: message(seq, { body: `새 메시지 ${seq}` }) };
    const start = performance.now();
    act(() => {
      server.socket.push(frame);
    });
    const end = performance.now();
    emitMs.push(emitted - start);
    commitMs.push(end - start);
    expect(screen.getByText(`새 메시지 ${seq}`)).toBeTruthy();
  }
  cleanup();
  return { n, emit: median(emitMs), commit: median(commitMs) };
}

describe('live append 마이크로벤치(W-10k C)', () => {
  it('메시지 100·500개에서 WS 1건 fold+emit·React 커밋 시간', async () => {
    const rows = [await bench(100), await bench(500)];
    // REPORT 근거용 출력(본문·ID 없음, 수치만).
    console.info('[bench] ' + rows.map((r) => `n=${r.n} emit=${r.emit.toFixed(2)}ms commit=${r.commit.toFixed(2)}ms`).join(' | '));
    for (const r of rows) expect(r.commit).toBeLessThan(2000);
  }, 60_000);
});
