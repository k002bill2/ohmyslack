/**
 * jsdom용 `matchMedia` 목. 앱이 만든 실제 쿼리 문자열(§5-1 범위 문법)을 폭에 대해 평가한다 —
 * 구간 이름으로 결과를 정하지 않으므로 쿼리·상수가 틀리면 테스트가 잡는다.
 */
type Listener = (e: MediaQueryListEvent) => void;

const LE = /^\(width <= ([\d.]+)px\)$/;
const GE = /^\(width >= ([\d.]+)px\)$/;
const BETWEEN = /^\(([\d.]+)px < width < ([\d.]+)px\)$/;

export function evaluate(query: string, width: number): boolean {
  const le = LE.exec(query);
  if (le) return width <= Number(le[1]);
  const ge = GE.exec(query);
  if (ge) return width >= Number(ge[1]);
  const between = BETWEEN.exec(query);
  if (between) return Number(between[1]) < width && width < Number(between[2]);
  throw new Error(`지원하지 않는 쿼리: ${query}`);
}

let width = 1280;
const lists = new Set<{ query: string; listeners: Set<Listener>; last: boolean }>();

export function installViewport(initial: number): void {
  width = initial;
  lists.clear();
  window.matchMedia = ((query: string) => {
    const entry = { query, listeners: new Set<Listener>(), last: evaluate(query, width) };
    lists.add(entry);
    return {
      get matches() {
        return evaluate(query, width);
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, l: Listener) => entry.listeners.add(l),
      removeEventListener: (_: string, l: Listener) => entry.listeners.delete(l),
      addListener: (l: Listener) => entry.listeners.add(l),
      removeListener: (l: Listener) => entry.listeners.delete(l),
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

/** 폭을 바꾸고 결과가 바뀐 쿼리의 change 리스너를 부른다. */
export function resizeTo(next: number): void {
  width = next;
  for (const entry of lists) {
    const now = evaluate(entry.query, width);
    if (now !== entry.last) {
      entry.last = now;
      entry.listeners.forEach((l) => l({ matches: now, media: entry.query } as MediaQueryListEvent));
    }
  }
}
