/**
 * 서비스 워커 라우팅·precache 로직(순수 함수, 저장소는 주입). 정본: TRD §6 — 해시된 앱 셸만 캐시,
 * `/api/**`·WS·비GET은 SW를 거치지 않는다(respondWith 하지 않음). 본문·인증 응답은 캐시하지 않는다.
 */

export interface PrecacheEntry {
  readonly url: string;
  /** 해시된 파일명은 null, 해시 없는 셸 파일(index.html·manifest·아이콘)은 내용 해시. */
  readonly revision: string | null;
}

export interface RequestLike {
  readonly url: string;
  readonly method: string;
  readonly mode: string;
  readonly headers: Headers;
}

export interface CacheLike {
  addAll(urls: readonly string[]): Promise<void>;
  match(request: RequestLike | string): Promise<Response | undefined>;
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<readonly string[]>;
  delete(name: string): Promise<boolean>;
}

export interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface FetchEventLike {
  readonly request: RequestLike;
  respondWith(response: Promise<Response>): void;
}

export type Route = 'bypass' | 'shell' | 'navigate';

export const CACHE_PREFIX = 'oms-shell-';
const SHELL_DOCUMENT = '/index.html';

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/** 요청을 우회·셸·탐색으로 분류한다. 우회가 기본값이다(모르는 요청은 SW가 손대지 않음). */
export function routeRequest(req: RequestLike, origin: string, shellUrls: ReadonlySet<string>): Route {
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== origin || isApiPath(url.pathname)) return 'bypass';
  if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') return 'bypass';
  if (req.mode === 'navigate') return 'navigate';
  return shellUrls.has(url.pathname) ? 'shell' : 'bypass';
}

/** 빌드가 주입한 precache 목록을 검증한다. 같은 출처 절대 경로만, `/api` 경로는 버린다. */
export function parsePrecacheManifest(raw: unknown): readonly PrecacheEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: PrecacheEntry[] = [];
  for (const item of raw as readonly unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { url, revision } = item as { url?: unknown; revision?: unknown };
    if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || isApiPath(url)) continue;
    entries.push({ url, revision: typeof revision === 'string' ? revision : null });
  }
  return entries;
}

/** 목록 내용으로 캐시 이름(버전)을 만든다 — 자원이 바뀌면 새 캐시, 이전 캐시는 activate에서 정리. */
export function cacheNameFor(entries: readonly PrecacheEntry[]): string {
  const text = entries.map((e) => `${e.url}@${e.revision ?? ''}`).join('\n');
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${CACHE_PREFIX}${hash.toString(36)}`;
}

export interface SwDeps {
  readonly storage: CacheStorageLike;
  readonly fetcher: (request: RequestLike) => Promise<Response>;
  readonly entries: readonly PrecacheEntry[];
  readonly origin: string;
}

export function createSwHandlers({ storage, fetcher, entries, origin }: SwDeps) {
  const name = cacheNameFor(entries);
  const shellUrls = new Set(entries.map((e) => e.url));

  async function cached(key: RequestLike | string): Promise<Response | undefined> {
    return (await storage.open(name)).match(key);
  }

  async function respond(route: Route, req: RequestLike): Promise<Response> {
    if (route === 'shell') return (await cached(req)) ?? fetcher(req);
    try {
      return await fetcher(req);
    } catch (error) {
      const shell = await cached(SHELL_DOCUMENT);
      if (shell !== undefined) return shell;
      throw error;
    }
  }

  return {
    onInstall(event: ExtendableEventLike): void {
      event.waitUntil(storage.open(name).then((cache) => cache.addAll(entries.map((e) => e.url))));
    },
    onActivate(event: ExtendableEventLike): void {
      event.waitUntil(
        storage
          .keys()
          .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== name).map((k) => storage.delete(k)))),
      );
    },
    onFetch(event: FetchEventLike): void {
      const route = routeRequest(event.request, origin, shellUrls);
      if (route === 'bypass') return;
      event.respondWith(respond(route, event.request));
    },
  };
}
