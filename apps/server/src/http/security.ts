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
    if (host === undefined || !hosts.has(host)) return sendError(request, reply, 400, 'host_not_allowed');
    // 등록되지 않은 경로는 Origin과 무관하게 404(라우트 존재를 Origin 검사가 드러내지 않게).
    if (!request.is404 && isStateChanging(request.method) && !isAllowedOrigin(headerValue(request, 'origin'), options.allowedOrigin)) {
      return sendError(request, reply, 403, 'origin_rejected');
    }
    return undefined;
  });
}

/** S6 헤더는 모든 응답, S5 `Cache-Control: no-store`는 `/api/**` 응답에 붙인다. */
export function registerResponseHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    const path = request.url.split('?')[0] ?? '';
    if (path === '/api' || path.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });
}
