/**
 * 구독 전에 활성 SW가 최신(push 핸들러 있음)인지 보장한다(W-23b). 새 SW가 설치 중·대기 중이면 활성화될 때까지 기다리고,
 * 대기에 걸려 있으면(skipWaiting 없는 옛 빌드가 남긴 상태) `update()`로 새 `/sw.js`를 받아 즉시 활성화시킨다.
 * 시간 안에 끝나지 않아도 구독은 진행한다(구독은 등록 단위라 이후 활성화된 SW가 push를 받는다).
 */

export interface WorkerLike {
  readonly state: string;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

export interface RegistrationLike {
  readonly installing: WorkerLike | null;
  readonly waiting: WorkerLike | null;
  update(): Promise<unknown>;
}

export const SW_ACTIVATE_TIMEOUT_MS = 10_000;

function activated(worker: WorkerLike, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (worker.state === 'activated' || worker.state === 'redundant') return resolve();
    const done = () => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (worker.state === 'activated' || worker.state === 'redundant') done();
    };
    const timer = setTimeout(done, timeoutMs);
    worker.addEventListener('statechange', onChange);
  });
}

export async function ensureActiveWorker(registration: RegistrationLike, timeoutMs = SW_ACTIVATE_TIMEOUT_MS): Promise<void> {
  if (registration.waiting !== null && registration.installing === null) {
    await registration.update().catch(() => undefined);
  }
  const pending = registration.installing ?? registration.waiting;
  if (pending !== null) await activated(pending, timeoutMs);
}
