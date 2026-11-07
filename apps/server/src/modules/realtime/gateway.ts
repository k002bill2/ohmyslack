import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../../http/errors.js';
import { isAllowedOrigin } from '../../http/security.js';
import {
  WS_FRAME_MAX_BYTES,
  WS_HEARTBEAT_MISSES,
  WS_HEARTBEAT_MS,
  WS_PATH,
  wsClientFrameSchema,
} from '../../shared.js';
import { sessionToken } from '../auth/guards.js';
import type { Authenticated } from '../auth/service.js';
import { createHub, type Hub, type HubDeps } from './hub.js';

export interface RealtimeOptions {
  /** heartbeat 간격(테스트 주입용). 기본 TRD §7 제안값 25초. */
  readonly heartbeatMs?: number;
}

export interface RealtimeDeps extends HubDeps {
  readonly allowedOrigin: string;
  readonly options?: RealtimeOptions;
}

declare module 'fastify' {
  interface FastifyRequest {
    wsAuth?: Authenticated;
  }
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function byteLength(data: unknown): number {
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) return data.reduce((n: number, b: Buffer) => n + b.length, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return 0;
}

function toText(data: unknown): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return '';
}

function parseFrame(text: string): ReturnType<typeof wsClientFrameSchema.safeParse> | undefined {
  try {
    return wsClientFrameSchema.safeParse(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * `/api/ws` 업그레이드(정본: TRD §4·§5·§5-1 S7, NC-09·NC-10·NC-26). handshake에서 쿠키 세션(비연장)·정확한 Origin·
 * 활성 사용자를 확인한다(Host 허용 목록은 전역 onRequest 가드). token은 URL로 받지 않는다.
 */
export async function registerRealtime(scope: FastifyInstance, deps: RealtimeDeps): Promise<Hub> {
  const hub = createHub(deps);
  const heartbeatMs = deps.options?.heartbeatMs ?? WS_HEARTBEAT_MS;
  await scope.register(websocket, { options: { maxPayload: WS_FRAME_MAX_BYTES } });
  scope.addHook('onClose', async () => hub.dispose());

  const handshake = async (request: FastifyRequest): Promise<void> => {
    if (!isAllowedOrigin(headerValue(request, 'origin'), deps.allowedOrigin)) throw new HttpError(403, 'origin_rejected');
    const found = await deps.auth.peek(sessionToken(request));
    if (found === undefined) throw new HttpError(401, 'unauthenticated');
    request.wsAuth = found;
  };

  scope.get(WS_PATH, { websocket: true, config: { access: 'account' }, preValidation: handshake }, (socket, request) => {
    const found = request.wsAuth;
    if (found === undefined) return socket.close(1008, 'unauthenticated');
    const conn = hub.attach(socket, {
      userId: found.user.id,
      sessionId: found.session.id,
      token: found.token,
      expiresAt: found.session.expiresAt,
    });
    let missed = 0;
    socket.on('pong', () => {
      missed = 0;
    });
    const beat = setInterval(() => {
      missed += 1;
      if (missed > WS_HEARTBEAT_MISSES) return socket.terminate();
      socket.ping();
      return undefined;
    }, heartbeatMs);
    beat.unref();
    socket.on('close', () => {
      clearInterval(beat);
      hub.detach(conn);
    });
    socket.on('message', (data: unknown, isBinary: boolean) => {
      if (byteLength(data) > WS_FRAME_MAX_BYTES) return hub.sendError(conn, 'frame_too_large', false);
      const parsed = isBinary ? undefined : parseFrame(toText(data));
      if (parsed === undefined || !parsed.success) return hub.sendError(conn, 'invalid_frame', false);
      const frame = parsed.data;
      if (frame.type === 'conversation.subscribe') return hub.subscribe(conn, frame.conversation_id, frame.after_cursor);
      return hub.unsubscribe(conn, frame.conversation_id);
    });
    return undefined;
  });
  return hub;
}
