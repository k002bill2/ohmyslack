import { describe, expect, it } from 'vitest';
import { createRealtimeClient, type SocketLike } from '../../src/data/realtime';

/**
 * 봇 전용 프레임 `membership.changed`(BOT_CHANNEL_SPEC §4-3)를 웹이 받아도 무시되는지: 파서는 그대로 넘기고
 * 연결을 닫거나 재연결하지 않는다(처리기 switch는 알려진 case만 다룬다). 웹 src는 바꾸지 않는다.
 */
describe('웹 실시간 — 모르는 프레임', () => {
  it('membership.changed 프레임은 onFrame으로 그대로 넘어가고 연결 종료·재연결·송신이 없다', () => {
    const sent: string[] = [];
    let closes = 0;
    let sockets = 0;
    let socket: SocketLike | undefined;
    const frames: unknown[] = [];
    const client = createRealtimeClient({
      url: 'ws://test/ws',
      createSocket: () => {
        sockets += 1;
        socket = { onopen: null, onclose: null, onmessage: null, onerror: null, readyState: 1, send: (d) => sent.push(d), close: () => (closes += 1) };
        return socket;
      },
      onFrame: (f) => frames.push(f),
      onOpen: () => undefined,
      onClose: () => (closes += 1),
      setTimer: () => undefined,
      clearTimer: () => undefined,
    });
    client.start();
    socket?.onopen?.({});
    const frame = { type: 'membership.changed', conversation_id: '00000000-0000-4000-8000-000000000001', state: 'joined' };
    expect(() => socket?.onmessage?.({ data: JSON.stringify(frame) })).not.toThrow();
    expect(frames).toEqual([frame]);
    expect(closes).toBe(0);
    expect(sockets).toBe(1);
    expect(sent).toEqual([]);
  });
});
