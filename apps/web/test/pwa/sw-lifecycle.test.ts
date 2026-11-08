import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserPushEnv, registerServiceWorker } from '../../src/features/pwa';
import { reloadOnControllerChange } from '../../src/features/pwa/register.js';
import { ensureActiveWorker, type RegistrationLike, type WorkerLike } from '../../src/features/pwa/sw-ready.js';

/** W-23b: 새 SW 즉시 활성화의 페이지 쪽 — controllerchange 1회 새로고침, 구독 전 활성 SW 보장. */

function container(controller: unknown) {
  const listeners: (() => void)[] = [];
  const c = {
    controller,
    addEventListener: (_type: 'controllerchange', l: () => void) => listeners.push(l),
    register: vi.fn(() => Promise.resolve(undefined)),
    change(next: unknown) {
      c.controller = next;
      for (const l of listeners) l();
    },
  };
  return c;
}

function worker(state: string) {
  const listeners = new Set<() => void>();
  const w = {
    state,
    addEventListener: (_t: 'statechange', l: () => void) => listeners.add(l),
    removeEventListener: (_t: 'statechange', l: () => void) => listeners.delete(l),
    to(next: string) {
      w.state = next;
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.size,
  };
  return w;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('W-23b controllerchange 새로고침', () => {
  it('이미 제어되던 페이지는 새 SW 장악 시 1회만 새로 고친다(루프 없음)', () => {
    const c = container({ id: 'old' });
    const reload = vi.fn();
    reloadOnControllerChange(c, reload);
    c.change({ id: 'new' });
    c.change({ id: 'newer' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('첫 설치(제어 없던 페이지)의 claim은 새로 고치지 않고, 그 뒤 다시 바뀌면 1회 새로 고친다', () => {
    const c = container(null);
    const reload = vi.fn();
    reloadOnControllerChange(c, reload);
    c.change({ id: 'first' });
    expect(reload).not.toHaveBeenCalled();
    c.change({ id: 'second' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('registerServiceWorker는 운영 빌드에서 controllerchange 새로고침을 건다', () => {
    const c = container({ id: 'old' });
    const reload = vi.fn();
    expect(registerServiceWorker({ prod: true, navigator: { serviceWorker: c }, reload })).toBe(true);
    expect(c.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    c.change({ id: 'new' });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('W-23b 구독 전 활성 SW 보장', () => {
  it('설치 중인 새 SW가 activated가 될 때까지 기다린다(update 호출 없음)', async () => {
    const installing = worker('installing');
    const reg: RegistrationLike = { installing, waiting: null, update: vi.fn(async () => undefined) };
    let done = false;
    const p = ensureActiveWorker(reg).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    installing.to('activated');
    await p;
    expect(done).toBe(true);
    expect(reg.update).not.toHaveBeenCalled();
    expect(installing.listenerCount()).toBe(0);
  });

  it('대기 중(waiting)에 걸린 SW는 update()로 새 SW를 받은 뒤 그 활성화를 기다린다', async () => {
    const stuck = worker('installed');
    const fresh = worker('installing');
    const reg = { installing: null as WorkerLike | null, waiting: stuck as WorkerLike | null, update: vi.fn(async () => undefined) };
    reg.update.mockImplementation(async () => {
      reg.installing = fresh;
    });
    const p = ensureActiveWorker(reg);
    await vi.waitFor(() => expect(fresh.listenerCount()).toBe(1));
    fresh.to('activated');
    await p;
    expect(reg.update).toHaveBeenCalledTimes(1);
  });

  it('활성화가 끝나지 않아도 시간 초과 후 진행한다, 대기 SW가 없으면 즉시 끝난다', async () => {
    vi.useFakeTimers();
    const slow = worker('installing');
    const p = ensureActiveWorker({ installing: slow, waiting: null, update: async () => undefined }, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(slow.listenerCount()).toBe(0);
    await ensureActiveWorker({ installing: null, waiting: null, update: async () => undefined });
  });

  it('update()가 끝나지 않아도(네트워크 지연) 전체 대기에 상한을 적용하고 진행한다 — Codex r3 P2', async () => {
    vi.useFakeTimers();
    const waiting = worker('installed');
    const p = ensureActiveWorker({ installing: null, waiting, update: () => new Promise(() => undefined) }, 1000);
    let done = false;
    void p.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(true);
  });

  it('browserPushEnv.pushManager는 활성 SW 보장 후에 pushManager를 돌려준다', async () => {
    const installing = worker('installing');
    const pushManager = { getSubscription: async () => null };
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      serviceWorker: { ready: Promise.resolve({ installing, waiting: null, update: async () => undefined, pushManager }) },
    });
    let got: unknown = 'pending';
    const p = browserPushEnv()
      .pushManager()
      .then((m) => (got = m));
    await vi.waitFor(() => expect(installing.listenerCount()).toBe(1));
    expect(got).toBe('pending');
    installing.to('activated');
    await p;
    expect(got).toBe(pushManager);
  });
});
