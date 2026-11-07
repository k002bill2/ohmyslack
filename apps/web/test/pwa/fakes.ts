import { vi } from 'vitest';
import type { CacheStorageLike, FetchEventLike, RequestLike } from '../../src/features/pwa';

/** Cache Storage 대역(메모리). 키는 URL 경로. */
export function fakeCacheStorage(initial: Readonly<Record<string, readonly string[]>> = {}) {
  const stores = new Map<string, Map<string, Response>>();
  for (const [name, urls] of Object.entries(initial)) {
    stores.set(name, new Map(urls.map((u) => [u, new Response(`old:${u}`)])));
  }
  const storage: CacheStorageLike = {
    async open(name) {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        async addAll(urls) {
          for (const u of urls) store.set(u, new Response(`net:${u}`));
        },
        async match(req) {
          return store.get(typeof req === 'string' ? req : new URL(req.url).pathname)?.clone();
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
  return { storage, stores };
}

export function request(path: string, init: { method?: string; mode?: string; origin?: string } = {}): RequestLike {
  return {
    url: `${init.origin ?? 'https://app.test'}${path}`,
    method: init.method ?? 'GET',
    mode: init.mode ?? 'cors',
    headers: new Headers(),
  };
}

export function fetchEvent(req: RequestLike): FetchEventLike & { respondWith: ReturnType<typeof vi.fn<(r: Promise<Response>) => void>> } {
  return { request: req, respondWith: vi.fn<(r: Promise<Response>) => void>() };
}
