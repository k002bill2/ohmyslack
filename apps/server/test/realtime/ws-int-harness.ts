import { createServer, type AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { WS_PATH, wsServerFrameSchema, type WsServerFrame } from '../../src/shared.js';
import { ORIGIN } from '../support/auth-app.js';

/** 실제 포트로 띄운 앱에 Node 내장 WebSocket으로 붙는 int 테스트 클라이언트(쿠키·Origin·Host 헤더 주입). */
export interface WsClient {
  readonly frames: WsServerFrame[];
  readonly socket: WebSocket;
  /** close 이벤트(코드)와 그 시각(performance.now). */
  closed: Promise<{ code: number; at: number }>;
  send(frame: unknown): void;
  sendRaw(data: string): void;
  waitFor(pred: (f: WsServerFrame) => boolean, timeoutMs?: number): Promise<WsServerFrame>;
  close(): void;
}

/** 빈 포트를 미리 고른다: 내장 WebSocket은 Host를 `127.0.0.1:<port>`로 고정하므로 앱 생성 때 extraHosts에 넣어야 한다. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export async function listen(app: FastifyInstance, port: number): Promise<string> {
  await app.listen({ host: '127.0.0.1', port });
  return `ws://127.0.0.1:${port}`;
}

/** 열린 클라이언트를 모두 닫은 뒤 앱을 닫는다(열린 소켓이 있으면 close가 늦어진다). */
export function closeAll(clients: readonly WsClient[]): void {
  for (const c of clients) if (c.socket.readyState <= 1) c.socket.close();
}

export interface ConnectOptions {
  readonly token?: string;
  readonly origin?: string;
  readonly host?: string;
}

/** 연결이 열리면 클라이언트를, handshake가 거부되면 `rejected`를 돌려준다. */
export function connect(base: string, opts: ConnectOptions = {}): Promise<WsClient | 'rejected'> {
  const headers: Record<string, string> = { origin: opts.origin ?? ORIGIN };
  if (opts.host !== undefined) headers.host = opts.host;
  if (opts.token !== undefined) headers.cookie = `${SESSION_COOKIE}=${opts.token}`;
  const socket = new WebSocket(`${base}${WS_PATH}`, { headers } as unknown as string[]);
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
          reject(new Error(`WS frame 대기 시간 초과: ${JSON.stringify(frames.map((f) => f.type))}`));
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

export async function connected(base: string, opts: ConnectOptions): Promise<WsClient> {
  const client = await connect(base, opts);
  if (client === 'rejected') throw new Error('WS 연결 거부');
  return client;
}

/** 구독 후 ACK까지 기다린다. */
export async function subscribe(client: WsClient, conversationId: string, afterCursor = 0): Promise<WsServerFrame> {
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

/** 사건 발생 시각부터 close까지 걸린 ms. */
export async function closeLatency(client: WsClient, startedAt: number, timeoutMs = 6000): Promise<{ code: number; ms: number }> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('WS close 대기 시간 초과')), timeoutMs));
  const { code, at } = await Promise.race([client.closed, timeout]);
  return { code, ms: at - startedAt };
}

/** 실제 포트 + 전체 저장소 앱(WS 포함) 컨텍스트. 지정 `it`이 파일 기존 컨텍스트와 별도로 쓴다. */
export interface WsIntContext {
  readonly conv: import('../conversations/conv-int-harness.js').ConvIntContext;
  readonly base: string;
  readonly clients: WsClient[];
  open(token: string): Promise<WsClient>;
  teardown(): Promise<void>;
}

export async function setupWsInt(): Promise<WsIntContext> {
  const { setupConvInt, teardownConvInt } = await import('../conversations/conv-int-harness.js');
  const port = await freePort();
  const conv = await setupConvInt({ extraHosts: [`127.0.0.1:${port}`] });
  const base = await listen(conv.app, port);
  const clients: WsClient[] = [];
  return {
    conv,
    base,
    clients,
    async open(token) {
      const client = await connected(base, { token });
      clients.push(client);
      return client;
    },
    async teardown() {
      closeAll(clients);
      await teardownConvInt(conv);
    },
  };
}
