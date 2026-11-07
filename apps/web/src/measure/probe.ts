/**
 * 표시 지연 측정 probe(W-10k C) — 측정 빌드(`VITE_LATENCY_PROBE=1`)에서만 `index.ts`가 동적 import한다.
 * 구간: ① ws(WS `message.created` 수신) ② emit(fold·emit 완료) ③ commit(해당 항목 DOM 존재) ④ raf(다음 rAF).
 * 각 시각 − 메시지 `created_at`과 구간 간 차이를 메모리 히스토그램에만 누적한다. 메시지 ID는 상관용 메모리 Map에서만 쓰고
 * ④ 뒤 지운다. 디스크·콘솔·네트워크로 내보내지 않는다. 노출: `window.__omsLatency.summary()`·`reset()`.
 */
import { createHistogram, type Histogram, type StageStats } from './histogram.js';
import { setProbeSink, type ProbeStage } from './hook.js';

export const STAGES = ['ws', 'emit', 'commit', 'raf', 'emit-ws', 'commit-emit', 'raf-commit'] as const;
export type StageName = (typeof STAGES)[number];

export interface LatencySummary {
  readonly stages: Readonly<Record<StageName, StageStats>>;
  readonly skipped: { readonly invalid: number; readonly alreadyInDom: number; readonly evicted: number };
  readonly pending: number;
}

export interface LatencyApi {
  readonly summary: () => LatencySummary;
  readonly reset: () => void;
}

declare global {
  interface Window {
    __omsLatency?: LatencyApi;
  }
}

export interface ProbeDeps {
  readonly now: () => number;
  readonly raf: (cb: () => void) => void;
  readonly doc: Document;
}

interface Entry {
  readonly created: number;
  readonly ws: number;
  emit?: number;
  commit?: number;
}

/** 열지 않은 대화·백그라운드 탭(rAF 정지)으로 끝나지 않는 항목이 쌓이지 않게 하는 상한. 넘으면 가장 오래된 것부터 버린다. */
export const MAX_PENDING = 500;
const ATTR = 'data-message-id';
const SAFE_ID = /^[\w-]+$/;

export interface Probe extends LatencyApi {
  readonly mark: (stage: ProbeStage, id: string, createdAt: string) => void;
  readonly observe: () => () => void;
}

function findItem(doc: Document, id: string): Element | null {
  return SAFE_ID.test(id) ? doc.querySelector(`[${ATTR}="${id}"]`) : null;
}

function idsIn(mutations: readonly MutationRecord[]): string[] {
  const ids: string[] = [];
  const collect = (el: Element) => {
    const own = el.getAttribute(ATTR);
    if (own !== null) ids.push(own);
    el.querySelectorAll(`[${ATTR}]`).forEach((child) => ids.push(child.getAttribute(ATTR) ?? ''));
  };
  for (const m of mutations) {
    if (m.type === 'attributes' && m.target instanceof Element) collect(m.target);
    m.addedNodes.forEach((node) => {
      if (node instanceof Element) collect(node);
    });
  }
  return ids;
}

export function createProbe(deps: ProbeDeps): Probe {
  const hist = Object.fromEntries(STAGES.map((s) => [s, createHistogram()])) as Record<StageName, Histogram>;
  const entries = new Map<string, Entry>();
  let skipped = { invalid: 0, alreadyInDom: 0, evicted: 0 };

  const finish = (id: string, e: Entry, raf: number) => {
    entries.delete(id);
    if (e.emit === undefined || e.commit === undefined) return;
    hist.ws.record(e.ws - e.created);
    hist.emit.record(e.emit - e.created);
    hist.commit.record(e.commit - e.created);
    hist.raf.record(raf - e.created);
    hist['emit-ws'].record(e.emit - e.ws);
    hist['commit-emit'].record(e.commit - e.emit);
    hist['raf-commit'].record(raf - e.commit);
  };

  const committed = (id: string) => {
    const e = entries.get(id);
    if (e?.emit === undefined || e.commit !== undefined) return;
    e.commit = deps.now();
    deps.raf(() => finish(id, e, deps.now()));
  };

  const onWs = (id: string, createdAt: string) => {
    const created = Date.parse(createdAt);
    if (Number.isNaN(created)) return void (skipped = { ...skipped, invalid: skipped.invalid + 1 });
    // 자기 메시지는 POST 응답 fold로 이미 그려져 있다 — 표시 지연 표본이 아니므로 세기만 한다.
    if (findItem(deps.doc, id) !== null) return void (skipped = { ...skipped, alreadyInDom: skipped.alreadyInDom + 1 });
    entries.set(id, { created, ws: deps.now() });
    if (entries.size > MAX_PENDING) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
      skipped = { ...skipped, evicted: skipped.evicted + 1 };
    }
  };

  const mark = (stage: ProbeStage, id: string, createdAt: string) => {
    if (stage === 'ws') return onWs(id, createdAt);
    const e = entries.get(id);
    if (e === undefined || e.emit !== undefined) return;
    e.emit = deps.now();
    // React가 emit 안에서 동기 커밋했을 수 있다 — 이미 있으면 MutationObserver를 기다리지 않는다.
    if (findItem(deps.doc, id) !== null) committed(id);
  };

  const observe = () => {
    const view = deps.doc.defaultView;
    if (view === null) return () => undefined;
    const observer = new view.MutationObserver((mutations) => idsIn(mutations).forEach(committed));
    observer.observe(deps.doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: [ATTR] });
    return () => observer.disconnect();
  };

  const summary = (): LatencySummary => ({
    stages: Object.fromEntries(STAGES.map((s) => [s, hist[s].summary()])) as Record<StageName, StageStats>,
    skipped: { ...skipped },
    pending: entries.size,
  });

  const reset = () => {
    STAGES.forEach((s) => hist[s].reset());
    entries.clear();
    skipped = { invalid: 0, alreadyInDom: 0, evicted: 0 };
  };

  return { mark, observe, summary, reset };
}

/** 측정 빌드 진입점: probe를 만들고 `data/` 훅 sink·DOM 관찰·콘솔 요약 함수를 설치한다(중복 설치 무시). */
export function install(): void {
  if (window.__omsLatency !== undefined) return;
  const probe = createProbe({ now: () => Date.now(), raf: (cb) => window.requestAnimationFrame(() => cb()), doc: document });
  probe.observe();
  setProbeSink(probe.mark);
  window.__omsLatency = Object.freeze({ summary: probe.summary, reset: probe.reset });
}
