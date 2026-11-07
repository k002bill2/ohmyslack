import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeMark, setProbeSink } from '../../src/measure/hook.js';
import { maybeInstallProbe } from '../../src/measure/index.js';
import { createProbe, MAX_PENDING } from '../../src/measure/probe.js';

const CREATED = '2026-11-08T00:00:00.000Z';
const T0 = Date.parse(CREATED);

function harness() {
  let t = T0;
  const frames: (() => void)[] = [];
  const probe = createProbe({ now: () => t, raf: (cb) => frames.push(cb), doc: document });
  const stop = probe.observe();
  return {
    probe,
    stop,
    at: (ms: number) => {
      t = T0 + ms;
    },
    flushRaf: () => frames.splice(0).forEach((cb) => cb()),
  };
}

function addItem(id: string): HTMLElement {
  const li = document.createElement('li');
  li.setAttribute('data-message-id', id);
  document.body.append(li);
  return li;
}

afterEach(() => {
  document.body.innerHTML = '';
  setProbeSink(null);
  vi.unstubAllEnvs();
  delete window.__omsLatency;
});

describe('W-10k C 측정 probe', () => {
  it('플래그 off면 설치하지 않고 window.__omsLatency도 없으며 훅은 sink를 부르지 않는다', () => {
    vi.stubEnv('VITE_LATENCY_PROBE', '');
    expect(maybeInstallProbe()).toBeUndefined();
    expect(window.__omsLatency).toBeUndefined();
    const sink = vi.fn();
    setProbeSink(sink);
    probeMark('ws', 'm1', CREATED);
    expect(sink).not.toHaveBeenCalled();
  });

  it('플래그 on이면 설치되어 summary·reset만 노출하고 훅이 sink로 전달된다', async () => {
    vi.stubEnv('VITE_LATENCY_PROBE', '1');
    await maybeInstallProbe();
    const api = window.__omsLatency;
    expect(api).toBeDefined();
    expect(Object.keys(api ?? {}).sort()).toEqual(['reset', 'summary']);
    expect(api?.summary().stages.raf).toEqual({ p50: 0, p95: 0, p99: 0, max: 0, n: 0 });
    probeMark('ws', 'm1', CREATED);
    expect(api?.summary().pending).toBe(1);
    api?.reset();
    expect(api?.summary().pending).toBe(0);
  });

  it('ws→emit→DOM 커밋(MutationObserver)→rAF 구간과 구간 차이를 기록하고 Map 항목을 지운다', async () => {
    const h = harness();
    h.at(20);
    h.probe.mark('ws', 'm1', CREATED);
    h.at(25);
    h.probe.mark('emit', 'm1', CREATED);
    h.at(40);
    addItem('m1');
    await Promise.resolve();
    h.at(56);
    h.flushRaf();
    const s = h.probe.summary();
    expect(s.stages.ws).toMatchObject({ p50: 20, n: 1 });
    expect(s.stages.emit.p50).toBe(25);
    expect(s.stages.commit.p50).toBe(40);
    expect(s.stages.raf.p50).toBe(56);
    expect(s.stages['emit-ws'].p50).toBe(5);
    expect(s.stages['commit-emit'].p50).toBe(15);
    expect(s.stages['raf-commit'].p50).toBe(16);
    expect(s.pending).toBe(0);
    h.stop();
  });

  it('emit 시점에 이미 그려졌으면 바로 커밋으로 보고, 속성 변경(id 교체)도 커밋으로 잡는다', async () => {
    const h = harness();
    h.probe.mark('ws', 'a', CREATED);
    addItem('a');
    h.at(10);
    h.probe.mark('emit', 'a', CREATED);
    const pendingLi = addItem('client-tmp');
    h.probe.mark('ws', 'b', CREATED);
    h.probe.mark('emit', 'b', CREATED);
    await Promise.resolve();
    pendingLi.setAttribute('data-message-id', 'b');
    await Promise.resolve();
    h.flushRaf();
    expect(h.probe.summary().stages.raf.n).toBe(2);
    h.stop();
  });

  it('이미 DOM에 있는 자기 메시지·잘못된 created_at은 표본에서 빼고 세며, 미완료 항목은 상한에서 밀려난다', () => {
    const h = harness();
    addItem('own');
    h.probe.mark('ws', 'own', CREATED);
    h.probe.mark('ws', 'bad', 'not-a-date');
    for (let i = 0; i <= MAX_PENDING; i += 1) h.probe.mark('ws', `p${String(i)}`, CREATED);
    const s = h.probe.summary();
    expect(s.skipped).toEqual({ invalid: 1, alreadyInDom: 1, evicted: 1 });
    expect(s.pending).toBe(MAX_PENDING);
    expect(s.stages.ws.n).toBe(0);
    h.stop();
  });
});
