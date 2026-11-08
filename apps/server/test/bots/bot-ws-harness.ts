import { randomBytes } from 'node:crypto';
import { connect as tcpConnect } from 'node:net';
import { wsServerFrameSchema, type WsServerFrame } from '../../src/shared.js';
import type { WsClient } from '../realtime/ws-int-harness.js';

/** 봇 WS(`/api/bot/v1/ws`) 테스트 클라이언트: Bearer 헤더만 싣는다(Origin·Cookie 없음). 거부되면 'rejected'. */
export function connectBot(port: number, token: string | undefined, extra: Record<string, string> = {}): Promise<WsClient | 'rejected'> {
  const headers: Record<string, string> = { ...extra };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/bot/v1/ws`, { headers } as unknown as string[]);
  const frames: WsServerFrame[] = [];
  const waiters = new Set<() => void>();
  const closed = new Promise<{ code: number; at: number }>((resolve) => {
    socket.addEventListener('close', (e) => resolve({ code: e.code, at: performance.now() }));
  });
  socket.addEventListener('message', (e) => {
    frames.push(wsServerFrameSchema.parse(JSON.parse(String(e.data))));
    for (const w of [...waiters]) w();
  });
  const client: WsClient = {
    frames,
    socket,
    closed,
    send: (frame) => socket.send(JSON.stringify(frame)),
    sendRaw: (data) => socket.send(data),
    waitFor(pred, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const check = (): void => {
          const hit = frames.find(pred);
          if (hit === undefined) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(hit);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`봇 WS frame 대기 시간 초과: ${JSON.stringify(frames.map((f) => f.type))}`));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    close: () => socket.close(),
  };
  return new Promise((resolve) => {
    socket.addEventListener('open', () => resolve(client));
    socket.addEventListener('error', () => resolve('rejected'));
  });
}

export async function connectedBot(port: number, token: string): Promise<WsClient> {
  const client = await connectBot(port, token);
  if (client === 'rejected') throw new Error('봇 WS 연결 거부');
  return client;
}

/**
 * raw TCP로 봇 WS 업그레이드를 보내 응답 상태 줄과 서버 측 소켓 종료까지 ms를 잰다(헤더를 그대로 제어: Origin·Cookie).
 * 클라이언트는 먼저 끊지 않는다 — 서버가 거부 후 소켓을 닫는지(W-09b P3 같은 처리)를 본다.
 */
export function probeBotUpgrade(
  port: number,
  headers: Record<string, string>,
  waitMs = 2000,
): Promise<{ readonly statusLine: string; readonly closedMs: number | null }> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: '127.0.0.1', port });
    let data = '';
    let sentAt = 0;
    let closedMs: number | null = null;
    const done = (): void => {
      socket.destroy();
      resolve({ statusLine: data.split('\r\n')[0] ?? '', closedMs });
    };
    const timer = setTimeout(done, waitMs);
    const ended = (): void => {
      if (closedMs === null) closedMs = performance.now() - sentAt;
      clearTimeout(timer);
      done();
    };
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      data += chunk;
    });
    socket.on('end', ended);
    socket.on('close', ended);
    socket.on('error', reject);
    socket.on('connect', () => {
      const lines = [
        'GET /api/bot/v1/ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${wsKey()}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      sentAt = performance.now();
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
  });
}

/** 업그레이드 요청용 무작위 16바이트 nonce(RFC 6455 4.1). */
export function wsKey(): string {
  return randomBytes(16).toString('base64');
}

/** 구독 ACK(또는 error)까지 기다린다. */
export async function subscribeBot(client: WsClient, conversationId: string, afterCursor = 0): Promise<WsServerFrame> {
  const from = client.frames.length;
  client.send({ type: 'conversation.subscribe', conversation_id: conversationId, after_cursor: afterCursor });
  return client.waitFor(
    (f) =>
      client.frames.indexOf(f) >= from &&
      (f.type === 'conversation.subscribed' || f.type === 'error') &&
      'conversation_id' in f &&
      f.conversation_id === conversationId,
  );
}
