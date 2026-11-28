/**
 * 클라이언트 계측 버퍼(PRD §10 2단계, TRD `POST /api/metrics`). 같은 (event, dims)를 메모리에서 합산했다가 주기·페이지 이탈 때
 * 한 배치로 보낸다. 디스크(localStorage·IndexedDB 등)에는 전혀 두지 않는다(PRD §10 메모리 전용, B7).
 * 기록·전송은 어떤 경우에도 예외를 내지 않는다 — 계측이 sync·전송·화면 결과를 바꾸지 못하게.
 */
import {
  CLIENT_METRIC_EVENTS,
  CLIENT_METRIC_MAX_N,
  CLIENT_METRIC_MAX_RECORDS,
  toMetricRecord,
  type ClientMetricEvent,
  type ClientMetricWire,
} from '../../../../packages/shared/src/metrics.js';
import type { FetchLike } from './api.js';

/** 관찰 지점이 넘기는 dims. undefined(구간 밖 값 등)가 있으면 allowlist 검증에서 레코드째 버린다. */
export type MetricDims = Readonly<Record<string, string | number | boolean | undefined>>;

/** 관찰 지점이 쓰는 기록 인터페이스(테스트는 가짜를 주입한다). */
export interface MetricsRecorder {
  record(event: ClientMetricEvent, dims: MetricDims): void;
}

/** 주기 전송 간격: 서버 집계 단위(배치 상한 주석의 「60초마다」, shared metrics.ts)와 같다. */
export const METRIC_FLUSH_MS = 60_000;
/**
 * 서로 다른 (event, dims) 키 상한. 클라이언트 3종의 실제 조합(수십 개)보다 넉넉하고 배치 2회(32×2)에 다 나간다.
 * 넘는 새 키는 버린다 — 메모리가 무한히 늘지 않게.
 */
export const METRIC_MAX_KEYS = 64;

export interface MetricsLifecycle {
  readonly doc: EventTarget & { readonly visibilityState: string };
  readonly win: EventTarget;
}

export interface MetricsBufferDeps {
  readonly fetch: FetchLike;
  /** 세션 CSRF 토큰. null이면 미인증 — 보내지 않고 메모리에 둔다. */
  readonly csrfToken: () => string | null;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface MetricsBuffer extends MetricsRecorder {
  /** 최대 CLIENT_METRIC_MAX_RECORDS개를 보낸다. 실패(네트워크·400 외 비2xx)면 다시 합친다. 예외 없음. */
  flush(): Promise<void>;
  /** 주기 전송·pagehide·visibility hidden 전송을 건다. 반환값은 해제 함수. */
  start(lifecycle?: MetricsLifecycle): () => void;
  /** 현재 버퍼(테스트·진단용 복사본). */
  pending(): readonly ClientMetricWire[];
}

type Entry = ClientMetricWire;

const isClientEvent = (e: string): e is ClientMetricEvent => (CLIENT_METRIC_EVENTS as readonly string[]).includes(e);

/** dims 키 정렬 문자열 — 같은 조합은 같은 키. */
const keyOf = (event: string, dims: MetricDims): string =>
  JSON.stringify([event, ...Object.keys(dims).sort().map((k) => [k, dims[k]])]);

/** 기존 버퍼에 항목들을 합친다(n 상한·키 상한, 넘친 것은 버림). 입력은 바꾸지 않는다. */
function mergeInto(buffer: ReadonlyMap<string, Entry>, entries: readonly Entry[]): ReadonlyMap<string, Entry> {
  const next = new Map(buffer);
  for (const e of entries) {
    const key = keyOf(e.event, e.dims);
    const prev = next.get(key);
    if (prev === undefined && next.size >= METRIC_MAX_KEYS) continue;
    next.set(key, { event: e.event, dims: e.dims, n: Math.min((prev?.n ?? 0) + e.n, CLIENT_METRIC_MAX_N) });
  }
  return next;
}

/** allowlist 통과 레코드 → 전송 항목(event를 뺀 dims). 위반이면 undefined. */
function toEntry(event: ClientMetricEvent, dims: MetricDims): Entry | undefined {
  const rec = toMetricRecord({ ...dims, event });
  if (rec === undefined || !isClientEvent(rec.event)) return undefined;
  const rest = Object.fromEntries(Object.entries(rec).filter(([k]) => k !== 'event')) as Record<string, string | number | boolean>;
  return { event: rec.event, dims: rest, n: 1 };
}

export function createMetricsBuffer(deps: MetricsBufferDeps): MetricsBuffer {
  let buffer: ReadonlyMap<string, Entry> = new Map();
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const send = async (batch: readonly Entry[], token: string): Promise<boolean> => {
    try {
      const res = await deps.fetch('/api/metrics', {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ records: batch }),
      });
      // 400: 형식 거부 — 다시 보내도 같다(재전송 루프 방지)이므로 버린다.
      return res.ok || res.status === 400;
    } catch {
      return false;
    }
  };

  const flush = async (): Promise<void> => {
    try {
      const token = deps.csrfToken();
      if (token === null || buffer.size === 0) return;
      const all = [...buffer.entries()];
      const batch = all.slice(0, CLIENT_METRIC_MAX_RECORDS);
      buffer = new Map(all.slice(CLIENT_METRIC_MAX_RECORDS));
      if (!(await send(batch.map(([, e]) => e), token))) buffer = mergeInto(buffer, batch.map(([, e]) => e));
    } catch {
      // 계측 실패는 삼킨다.
    }
  };

  return {
    record(event, dims) {
      try {
        const entry = toEntry(event, dims);
        if (entry !== undefined) buffer = mergeInto(buffer, [entry]);
      } catch {
        // 계측 실패는 삼킨다.
      }
    },
    flush,
    pending: () => [...buffer.values()],
    start(lifecycle) {
      let timer: unknown = null;
      let active = true;
      const tick = () => {
        timer = null;
        void flush();
        if (active) timer = setTimer(tick, METRIC_FLUSH_MS);
      };
      timer = setTimer(tick, METRIC_FLUSH_MS);
      const onHide = () => void flush();
      const onVisibility = () => {
        if (lifecycle?.doc.visibilityState === 'hidden') void flush();
      };
      lifecycle?.win.addEventListener('pagehide', onHide);
      lifecycle?.doc.addEventListener('visibilitychange', onVisibility);
      return () => {
        active = false;
        if (timer !== null) clearTimer(timer);
        timer = null;
        lifecycle?.win.removeEventListener('pagehide', onHide);
        lifecycle?.doc.removeEventListener('visibilitychange', onVisibility);
      };
    },
  };
}
