/**
 * 브라우저 WebSocket 클라이언트(TRD §4, same-origin `/api/ws`). 끊기면 지수 백오프로 다시 연결한다.
 * heartbeat: 서버 ping(TRD §7)은 브라우저가 프로토콜 수준에서 자동으로 pong한다 — 앱 프레임 계약에 heartbeat 메시지는 없다.
 * 백오프 간격·상한은 정본 없음(UI_STATES Q-12) → 아래 값은 구현 기본값이며 REPORT에 남긴다.
 */
import type { WsClientFrame, WsServerFrame } from '../../../../packages/shared/src/index.js';

export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { readonly code: number }) => void) | null;
  onmessage: ((ev: { readonly data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
}

export interface RealtimeDeps {
  readonly url: string;
  readonly createSocket: (url: string) => SocketLike;
  readonly onFrame: (frame: WsServerFrame) => void;
  readonly onOpen: () => void;
  /** 의도하지 않은 종료. `policy`=1008(세션 만료·폐기·비활성화, TRD §5-1 S7). */
  readonly onClose: (info: { readonly policy: boolean }) => void;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
const FRAME_MAX_BYTES = 64 * 1024;
const OPEN = 1;
const POLICY = 1008;

export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
}

function parseFrame(data: unknown): WsServerFrame | null {
  if (typeof data !== 'string' || data.length > FRAME_MAX_BYTES) return null;
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string') {
      return value as WsServerFrame;
    }
  } catch {
    // 형식이 틀린 프레임은 버린다(유실은 REST catch-up이 회복한다, TRD §4).
  }
  return null;
}

export function createRealtimeClient(deps: RealtimeDeps) {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let socket: SocketLike | null = null;
  let attempt = 0;
  let timer: unknown = null;
  let stopped = true;

  const connect = () => {
    timer = null;
    const ws = deps.createSocket(deps.url);
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      deps.onOpen();
    };
    ws.onmessage = (ev) => {
      const frame = parseFrame(ev.data);
      if (frame !== null) deps.onFrame(frame);
    };
    ws.onerror = () => undefined;
    ws.onclose = (ev) => {
      if (socket !== ws) return;
      socket = null;
      if (stopped) return;
      const policy = ev.code === POLICY;
      deps.onClose({ policy });
      if (policy) return;
      timer = setTimer(connect, backoffDelay(attempt));
      attempt += 1;
    };
  };

  return {
    /** 멈춤 상태이거나 1008 정책 종료로 재연결이 멈춘 상태(소켓·타이머 없음)에서만 연결을 시작한다. */
    start(): void {
      if (!stopped && (socket !== null || timer !== null)) return;
      stopped = false;
      connect();
    },
    /** 열려 있지 않으면 보내지 않고 false(재연결 후 복귀 절차가 다시 구독한다). */
    send(frame: WsClientFrame): boolean {
      if (socket === null || socket.readyState !== OPEN) return false;
      socket.send(JSON.stringify(frame));
      return true;
    },
    isOpen: (): boolean => socket !== null && socket.readyState === OPEN,
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      const ws = socket;
      socket = null;
      ws?.close(1000);
    },
  };
}

export type RealtimeClient = ReturnType<typeof createRealtimeClient>;
