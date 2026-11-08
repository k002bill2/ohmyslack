/**
 * 작은 경로 상태(DESIGN_REFERENCE §4-2, UI_STATES §3-3). 라우터 라이브러리 없이 `history.pushState`/`popstate`만 쓴다.
 * 다음 레인(W-10h)은 `/settings/members`(kind `members`)를 이 모듈에서 그대로 읽는다.
 */

export type Route =
  | { readonly kind: 'root' }
  | { readonly kind: 'conversation'; readonly conversationId: string }
  | { readonly kind: 'login' }
  | { readonly kind: 'invite' }
  /** `/settings/members` — 다음 레인(W-10h) 자리. 이 레인은 경로만 해석한다. */
  | { readonly kind: 'members' }
  /** compact 화면 `/discover`(CMP-23), medium·wide는 Dialog(UI_STATES §3-2). */
  | { readonly kind: 'discover' }
  /** compact 화면 `/dm/new`(CMP-24), medium·wide는 Dialog. */
  | { readonly kind: 'dm-new' };

const FIXED: Readonly<Record<string, Route>> = Object.freeze({
  '/': { kind: 'root' },
  '/login': { kind: 'login' },
  '/invite': { kind: 'invite' },
  '/settings/members': { kind: 'members' },
  '/discover': { kind: 'discover' },
  '/dm/new': { kind: 'dm-new' },
});

/** 경로 문자열(쿼리·해시 제외) → Route. 모르는 경로는 `root`. */
export function parseRoute(pathname: string): Route {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const fixed = FIXED[path];
  if (fixed !== undefined) return fixed;
  const m = /^\/c\/([^/]+)$/.exec(path);
  if (m?.[1] !== undefined) {
    try {
      return { kind: 'conversation', conversationId: decodeURIComponent(m[1]) };
    } catch {
      return { kind: 'root' };
    }
  }
  return { kind: 'root' };
}

/** Route → 경로 문자열. */
export function formatRoute(route: Route): string {
  switch (route.kind) {
    case 'root':
      return '/';
    case 'conversation':
      return `/c/${encodeURIComponent(route.conversationId)}`;
    case 'login':
      return '/login';
    case 'invite':
      return '/invite';
    case 'members':
      return '/settings/members';
    case 'discover':
      return '/discover';
    case 'dm-new':
      return '/dm/new';
  }
}

/** 주소 읽기·바꾸기·뒤로가기 구독. 운영은 `browserHistory`, 테스트는 `createMemoryHistory`. */
export interface RouteHistory {
  /** 현재 경로(쿼리·해시 제외). */
  pathname(): string;
  /** 현재 쿼리(`?thread=…` 포함, W-10i). 없으면 쿼리를 읽지 않는다. */
  search?(): string;
  /** 현재 해시(`#message-…` 포함, 알림 탭 위치 복원). 없으면 해시를 읽지 않는다. */
  hash?(): string;
  push(path: string): void;
  replace(path: string): void;
  /** 뒤로·앞으로(`popstate`) 때 호출. 해제 함수를 돌려준다. */
  listen(onPop: () => void): () => void;
}

/** `window.history` 배선. */
export const browserHistory: RouteHistory = Object.freeze({
  pathname: () => location.pathname,
  search: () => location.search,
  hash: () => location.hash,
  push: (path: string) => history.pushState(null, '', path),
  replace: (path: string) => history.replaceState(null, '', path),
  listen(onPop: () => void) {
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  },
});

export interface MemoryHistory extends RouteHistory {
  /** 쌓인 항목(테스트 확인용 복사본). */
  entries(): readonly string[];
  /** 브라우저 뒤로가기 흉내: 한 칸 뒤로 가고 `popstate` 구독자에게 알린다. */
  back(): void;
}

/** 항목에서 `#…`를 뗀다(경로·쿼리 해석용). */
function withoutHash(entry: string): string {
  const at = entry.indexOf('#');
  return at < 0 ? entry : entry.slice(0, at);
}

/** 테스트 주입용 메모리 히스토리. */
export function createMemoryHistory(initial = '/'): MemoryHistory {
  let stack: readonly string[] = [initial];
  let index = 0;
  const listeners = new Set<() => void>();
  return {
    pathname: () => withoutHash(stack[index] ?? '/').split('?')[0] ?? '/',
    search: () => {
      const entry = withoutHash(stack[index] ?? '/');
      const at = entry.indexOf('?');
      return at < 0 ? '' : entry.slice(at);
    },
    hash: () => {
      const entry = stack[index] ?? '/';
      const at = entry.indexOf('#');
      return at < 0 ? '' : entry.slice(at);
    },
    push(path) {
      stack = [...stack.slice(0, index + 1), path];
      index = stack.length - 1;
    },
    replace(path) {
      stack = stack.map((p, i) => (i === index ? path : p));
    },
    listen(onPop) {
      listeners.add(onPop);
      return () => listeners.delete(onPop);
    },
    entries: () => [...stack],
    back() {
      if (index === 0) return;
      index -= 1;
      listeners.forEach((l) => l());
    },
  };
}

/** `?thread=:rootMessageId`(D §4-2 스레드 라우트, UI_STATES §3-3 T2) → root id. 없거나 비면 null(W-10i). */
export function parseThreadParam(search: string): string | null {
  const value = new URLSearchParams(search).get('thread');
  return value === null || value === '' ? null : value;
}

/** 경로에 `?thread=` 쿼리를 붙인다(null이면 경로 그대로). */
export function withThread(path: string, rootId: string | null): string {
  return rootId === null ? path : `${path}?${new URLSearchParams({ thread: rootId }).toString()}`;
}
