import { connect as tcpConnect, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WS_PATH } from '../../src/shared.js';
import { ORIGIN } from '../support/auth-app.js';
import { setupConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { freePort, listen } from './ws-int-harness.js';

/**
 * 거부된 WS 업그레이드의 raw 소켓 정리(W-09b 리뷰 P3). 업그레이드 요청은 http 서버의 응답 수명주기 밖에서 처리되므로
 * 전역 onRequest(Host 허용 목록, NC-04)가 응답한 뒤 서버가 소켓을 닫지 않으면 클라이언트가 끊을 때까지 남고
 * `app.close()`가 그 소켓을 기다린다. 127.0.0.1 고정 + raw TCP로 재현한다(내장 WebSocket은 Host를 바꿀 수 없다).
 */
let ctx: ConvIntContext;
let port: number;
let appClosed = false;
const sockets: Socket[] = [];

beforeEach(async () => {
  port = await freePort();
  ctx = await setupConvInt({ extraHosts: [`127.0.0.1:${port}`] });
  await listen(ctx.app, port);
  appClosed = false;
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  if (!appClosed) await ctx.app.close();
  await ctx.schema.drop();
});

interface Probe {
  /** 응답 상태 줄(`HTTP/1.1 400 Bad Request`). */
  readonly statusLine: string;
  /** 요청을 보낸 뒤 서버가 소켓을 닫기까지 ms. 상한 안에 닫히지 않으면 null. */
  readonly closedMs: number | null;
  readonly socket: Socket;
}

/** 유효한 업그레이드 요청을 raw로 보내고 응답 상태 줄과 서버 측 종료(end/close) 시각을 잰다. 클라이언트는 먼저 끊지 않는다. */
function probeUpgrade(host: string, waitMs = 2000): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: '127.0.0.1', port });
    sockets.push(socket);
    let data = '';
    let sentAt = 0;
    let closedMs: number | null = null;
    const done = (): void => resolve({ statusLine: data.split('\r\n')[0] ?? '', closedMs, socket });
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
      sentAt = performance.now();
      socket.write(
        [
          `GET ${WS_PATH} HTTP/1.1`,
          `Host: ${host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          `Origin: ${ORIGIN}`,
          '',
          '',
        ].join('\r\n'),
      );
    });
  });
}

/** 클라이언트 소켓을 열어 둔 채 app.close()가 끝나기까지 ms(상한 초과면 null). */
async function closeAppMs(limitMs = 3000): Promise<number | null> {
  const started = performance.now();
  const closed = ctx.app.close().then(() => performance.now() - started);
  appClosed = true;
  return Promise.race([closed, new Promise<null>((r) => setTimeout(() => r(null), limitMs))]);
}

describe('거부된 WS 업그레이드 소켓', () => {
  it('허용 목록 밖 Host 업그레이드는 400 뒤 서버가 소켓을 닫고 app.close()가 바로 끝난다', async () => {
    const probe = await probeUpgrade('evil.example');
    expect(probe.statusLine).toBe('HTTP/1.1 400 Bad Request');
    expect(probe.closedMs).not.toBeNull();
    expect(probe.closedMs ?? Infinity).toBeLessThan(1000);
    const ms = await closeAppMs();
    expect(ms).not.toBeNull();
    expect(ms ?? Infinity).toBeLessThan(1000);
  });

  it('대조군: 허용 Host·쿠키 없음(handshake 401)도 서버가 소켓을 닫고 app.close()가 바로 끝난다', async () => {
    const probe = await probeUpgrade(`127.0.0.1:${port}`);
    expect(probe.statusLine).toBe('HTTP/1.1 401 Unauthorized');
    expect(probe.closedMs).not.toBeNull();
    expect(probe.closedMs ?? Infinity).toBeLessThan(1000);
    const ms = await closeAppMs();
    expect(ms).not.toBeNull();
    expect(ms ?? Infinity).toBeLessThan(1000);
  });
});
