import type { WsServerFrame } from '../../apps/server/src/shared.js';
import { SESSION_COOKIE } from '../../apps/server/src/modules/auth/routes.js';
import type { Session } from '../../apps/server/test/auth/members-int-harness.js';
import { ORIGIN } from '../../apps/server/test/support/auth-app.js';

/** 수신 프레임과 도착 시각(ms, performance.now). */
export interface Received {
  readonly frame: WsServerFrame;
  readonly at: number;
}

type SubscribedFrame = Extract<WsServerFrame, { type: 'conversation.subscribed' }>;

/**
 * 실제 소켓 WS 클라이언트(Node 내장 WebSocket). 쿠키·Origin은 headers로 보낸다(Host는 런타임이 정한다).
 * 모든 프레임을 순서대로 모으고 predicate를 timeout 안에 기다린다.
 */
export class WsClient {
  readonly received: Received[] = [];
  private waiters: (() => void)[] = [];
  private closedFlag = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev: MessageEvent) => {
      this.received.push({ frame: JSON.parse(String(ev.data)) as WsServerFrame, at: performance.now() });
      this.wake();
    });
    ws.addEventListener('close', () => {
      this.closedFlag = true;
      this.wake();
    });
  }

  static open(wsUrl: string, session: Session, timeoutMs = 5000): Promise<WsClient> {
    const init = { headers: { cookie: `${SESSION_COOKIE}=${session.token}`, origin: ORIGIN } };
    const ws = new WebSocket(wsUrl, init as unknown as string[]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS open timeout')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new WsClient(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WS 연결 실패'));
      });
    });
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  frames(): WsServerFrame[] {
    return this.received.map((r) => r.frame);
  }

  subscribe(conversationId: string, afterCursor: number): void {
    this.ws.send(JSON.stringify({ type: 'conversation.subscribe', conversation_id: conversationId, after_cursor: afterCursor }));
  }

  async subscribed(conversationId: string, timeoutMs = 10_000): Promise<SubscribedFrame> {
    const r = await this.waitFor((f) => f.type === 'conversation.subscribed' && f.conversation_id === conversationId, timeoutMs);
    return r.frame as SubscribedFrame;
  }

  /** 이미 받은 것 포함, predicate를 만족하는 첫 프레임을 기다린다. */
  async waitFor(pred: (f: WsServerFrame) => boolean, timeoutMs: number): Promise<Received> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const hit = this.received.find((r) => pred(r.frame));
      if (hit !== undefined) return hit;
      const left = deadline - performance.now();
      if (left <= 0) throw new Error(`WS 프레임 대기 시간 초과(${timeoutMs}ms)`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  close(): Promise<void> {
    if (this.closedFlag) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      this.ws.addEventListener('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.close();
    });
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}
