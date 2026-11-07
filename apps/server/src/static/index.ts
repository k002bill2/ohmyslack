import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from '../http/errors.js';
import { isApiPath } from '../http/security.js';

/**
 * 웹 앱 셸 정적 서빙(정본: TRD §6 같은 출처, DEV_DESIGN §2-2 B7).
 * 해시된 `/assets/*`만 장기 캐시하고, 셸(index.html·sw.js·manifest·precache-manifest)과 해시 없는 파일은 `no-cache`다.
 */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export const REVALIDATE_CACHE = 'no-cache';

/**
 * 서버 패키지 루트(`package.json`이 있는 `apps/server`). 소스(`src/static`)·빌드(`dist/apps/server/src/static`)
 * 어느 쪽에서 실행돼도 같은 값이다 — 빌드 쪽의 `dist/apps/server`에는 package.json이 없어 건너뛴다.
 */
function serverPackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (let dir = here; dir !== dirname(dir); dir = dirname(dir)) {
    if (dir.endsWith(`${sep}apps${sep}server`) && existsSync(join(dir, 'package.json'))) return dir;
  }
  return resolve(here, '..', '..');
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `WEB_DIST_DIR`(없으면 서버 패키지 기준 `../web/dist`)이 디렉터리면 절대 경로, 아니면 undefined(API만 서빙). */
export function resolveWebDistDir(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.WEB_DIST_DIR;
  const dir = configured === undefined || configured === '' ? resolve(serverPackageRoot(), '..', 'web', 'dist') : resolve(configured);
  return isDirectory(dir) ? dir : undefined;
}

/** 루트 안의 일반 파일이면 루트 기준 상대 경로. `..` 세그먼트·점 파일·루트 밖·디렉터리는 undefined. */
function resolveFile(root: string, wildcard: string): string | undefined {
  const segments = wildcard.split(/[/\\]/).filter((s) => s !== '');
  if (segments.length === 0 || segments.some((s) => s.startsWith('.') || s.includes('\0'))) return undefined;
  const absolute = resolve(root, ...segments);
  if (!absolute.startsWith(root + sep)) return undefined;
  try {
    return statSync(absolute).isFile() ? segments.join('/') : undefined;
  } catch {
    return undefined;
  }
}

function cacheControlFor(relative: string): string {
  return relative.startsWith('assets/') ? IMMUTABLE_CACHE : REVALIDATE_CACHE;
}

function acceptsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  return typeof accept === 'string' && accept.toLowerCase().includes('text/html');
}

function serve(root: string, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  // `/api/**`(퍼센트 인코딩·대소문자 변형 포함)는 정적·SPA 대상이 아니다 — 기존 JSON 404를 유지한다.
  if (isApiPath(request)) return sendError(request, reply, 404, 'not_found');
  const wildcard = (request.params as { readonly '*'?: string })['*'] ?? '';
  const file = resolveFile(root, wildcard === '' ? 'index.html' : wildcard);
  if (file !== undefined) return reply.header('cache-control', cacheControlFor(file)).sendFile(file);
  // SPA fallback: 파일이 없고 HTML을 원하는 탐색 요청만 index.html.
  if (acceptsHtml(request) && resolveFile(root, 'index.html') !== undefined) {
    return reply.header('cache-control', REVALIDATE_CACHE).sendFile('index.html');
  }
  return sendError(request, reply, 404, 'not_found');
}

/** `root`(절대 경로 디렉터리)의 파일을 GET/HEAD로 서빙한다. `/api` 라우트는 더 구체적이라 먼저 매칭된다. */
export async function registerStatic(app: FastifyInstance, root: string): Promise<void> {
  await app.register(fastifyStatic, { root, serve: false, cacheControl: false, dotfiles: 'deny', index: false });
  app.get('/*', { config: { access: 'public' } }, (request, reply) => serve(root, request, reply));
}
