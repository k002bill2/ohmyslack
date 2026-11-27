import { posix } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from './errors.js';

/** TRD §5-1 S6 보안 헤더(모든 HTML·API 응답). */
export const SECURITY_HEADERS = Object.freeze({
  'content-security-policy':
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isStateChanging(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/** Host 헤더를 http 기준 host(기본 포트 제거)로 정규화한다. 형식 오류는 undefined. */
export function normalizeHost(host: string | undefined): string | undefined {
  if (host === undefined || host === '' || /[\s/@?#\\]/.test(host)) return undefined;
  try {
    return new URL(`http://${host}`).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Origin이 허용 출처와 스킴·호스트·포트까지 정확히 같은지(NC-03). 없음·`null`은 거부. */
export function isAllowedOrigin(origin: string | undefined, allowedOrigin: string): boolean {
  if (origin === undefined || origin === 'null' || origin !== allowedOrigin) return false;
  try {
    return new URL(origin).origin === allowedOrigin;
  } catch {
    return false;
  }
}

export interface SecurityOptions {
  /** 정규화된 허용 origin(예: `https://ohmy.test`). */
  readonly allowedOrigin: string;
  /** 정규화된 허용 Host 목록(NC-04). */
  readonly allowedHosts: readonly string[];
  /** 가드 거부 신호(오류 code: `host_not_allowed`·`origin_rejected`). 계측용 — 응답은 바꾸지 않는다. */
  readonly onDenied?: (request: FastifyRequest, code: string) => void;
}

/** 거부 신호 호출. 관찰자 예외는 응답 경로로 올리지 않는다. */
export function notifyDenied(onDenied: ((request: FastifyRequest, code: string) => void) | undefined, request: FastifyRequest, code: string): void {
  try {
    onDenied?.(request, code);
  } catch {
    // 계측 실패는 응답을 바꾸지 않는다.
  }
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Host 허용 목록(NC-04) → 상태 변경 Origin 검사(NC-03) 순서로 거른다. 프록시·신원 헤더는 보지 않는다(NC-06). */
export function registerRequestGuards(app: FastifyInstance, options: SecurityOptions): void {
  const hosts = new Set(options.allowedHosts);
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const host = normalizeHost(headerValue(request, 'host'));
    if (host === undefined || !hosts.has(host)) {
      notifyDenied(options.onDenied, request, 'host_not_allowed');
      return sendError(request, reply, 400, 'host_not_allowed');
    }
    // 등록되지 않은 경로는 Origin과 무관하게 404(라우트 존재를 Origin 검사가 드러내지 않게).
    if (!request.is404 && isStateChanging(request.method) && !isAllowedOrigin(headerValue(request, 'origin'), options.allowedOrigin)) {
      notifyDenied(options.onDenied, request, 'origin_rejected');
      return sendError(request, reply, 403, 'origin_rejected');
    }
    return undefined;
  });
  // 업그레이드 요청은 http 응답 수명주기 밖이라, 위 가드가 @fastify/websocket의 onRequest보다 먼저 응답하면
  // 플러그인의 소켓 정리가 돌지 않아 raw 소켓이 남는다(W-09b P3). 일반 응답으로 끝난 업그레이드는 여기서 닫는다.
  // 업그레이드에 성공한 요청은 hijack되어 onResponse가 돌지 않는다.
  // `upgrade`는 Node http 파서가 'upgrade' 이벤트로 넘긴 요청에 세우는 런타임 필드다(@types/node 미선언).
  app.addHook('onResponse', async (request: FastifyRequest) => {
    if ((request.raw as { readonly upgrade?: boolean }).upgrade === true) request.raw.socket.destroy();
  });
}

function underApi(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/**
 * 원시 URL 경로를 판정용으로 정규화한다: 퍼센트 디코드(`%2F` 포함) → 소문자 → 중복 슬래시·점 세그먼트 정리.
 * 디코드할 수 없으면 undefined.
 */
export function normalizePath(rawUrl: string): string | undefined {
  const raw = rawUrl.split('?')[0] ?? '';
  try {
    return posix.normalize(decodeURIComponent(raw).toLowerCase());
  } catch {
    return undefined;
  }
}

/**
 * `/api/**` 요청인지(F-4). 매칭된 라우트 패턴이 `/api`면 참이고, 그 밖에는 원시 경로를 정규화해 본다 —
 * `/%61pi/…`·`/API/…`·`//api/…` 같은 변형도 `/api`로 취급한다. 디코드 불가 경로는 보수적으로 참.
 */
export function isApiPath(request: FastifyRequest): boolean {
  const route = request.routeOptions.url;
  if (route !== undefined && underApi(route)) return true;
  const path = normalizePath(request.url);
  return path === undefined || underApi(path);
}

/** S6 헤더(+`/api`면 S5 no-store)를 응답에 직접 싣는다. onSend를 거치지 않는 경로(frameworkErrors)도 쓴다. */
export function applyResponseHeaders(request: FastifyRequest, reply: FastifyReply): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
  if (isApiPath(request)) reply.header('cache-control', 'no-store');
}

/** S6 헤더는 모든 응답, S5 `Cache-Control: no-store`는 `/api/**` 응답에 붙인다. */
export function registerResponseHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    applyResponseHeaders(request, reply);
    return payload;
  });
}

/**
 * Fastify 프레임워크 오류(`FST_ERR_BAD_URL` 등) 처리기(F-5). 이 경로는 onRequest 가드·onSend 훅보다 앞에서 응답되므로
 * Host 허용 목록(NC-04)과 S6 헤더를 여기서 직접 적용한다. 본문은 TRD §3 형식이고 원문 경로·메시지를 싣지 않는다.
 */
export function frameworkErrorHandler(allowedHosts: readonly string[], onDenied?: (request: FastifyRequest, code: string) => void) {
  const hosts = new Set(allowedHosts);
  return (_error: unknown, request: FastifyRequest, reply: FastifyReply): void => {
    const host = normalizeHost(headerValue(request, 'host'));
    applyResponseHeaders(request, reply);
    const code = host !== undefined && hosts.has(host) ? 'invalid_request' : 'host_not_allowed';
    if (code === 'host_not_allowed') notifyDenied(onDenied, request, code);
    void sendError(request, reply, 400, code);
  };
}
