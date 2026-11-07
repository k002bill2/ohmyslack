/**
 * 로그인 시도 제한(정본: TRD §5-1 S1). 프로세스 메모리에만 두며 IP·프록시 헤더는 키로 쓰지 않는다.
 * - 계정별: 15분 창 안에서 실패 5회 → 그 계정을 15분 차단.
 * - 전역: 15분 창 안에서 (미존재 계정 포함) 실패 20회 → 모든 로그인을 15분 차단.
 * - 성공은 그 계정의 실패·차단만 지운다(전역 카운트는 그대로).
 */
export const LOGIN_LIMITS = Object.freeze({ windowMs: 15 * 60_000, blockMs: 15 * 60_000, perAccount: 5, global: 20 });

/** 현재 시각(epoch ms). 테스트에서 주입한다. */
export type Clock = () => number;

export interface LoginLimiter {
  /** true if a login attempt for this (normalized email) key is currently allowed (neither account nor global block active). */
  isAllowed(accountKey: string): boolean;
  /** record a failed attempt (call for unknown accounts too). */
  recordFailure(accountKey: string): void;
  /** successful login: clear this account's failures/block. */
  recordSuccess(accountKey: string): void;
}

/** 실패 시각 목록과 차단 해제 시각. 항상 새 객체로 교체한다. */
interface FailureState {
  readonly failures: readonly number[];
  readonly blockedUntil: number;
}

const EMPTY_STATE: FailureState = Object.freeze({ failures: Object.freeze([]), blockedUntil: 0 });

function isBlocked(state: FailureState, now: number): boolean {
  return now < state.blockedUntil;
}

/** 창(ts > now - windowMs) 밖의 실패를 버린 새 상태. */
function pruneState(state: FailureState, now: number, windowMs: number): FailureState {
  const cutoff = now - windowMs;
  return { failures: state.failures.filter((ts) => ts > cutoff), blockedUntil: state.blockedUntil };
}

/** 차단도 끝났고 창 안의 실패도 없으면 지워도 되는 상태다. */
function isExpired(state: FailureState, now: number, windowMs: number): boolean {
  return !isBlocked(state, now) && pruneState(state, now, windowMs).failures.length === 0;
}

/** 실패 하나를 더한 새 상태. 임계치에 닿으면 차단을 걸고 목록을 비운다(해제 후 새로 센다). */
function addFailure(state: FailureState, now: number, threshold: number, limits: typeof LOGIN_LIMITS): FailureState {
  const failures = [...pruneState(state, now, limits.windowMs).failures, now];
  if (failures.length >= threshold) return { failures: [], blockedUntil: now + limits.blockMs };
  return { failures, blockedUntil: state.blockedUntil };
}

/**
 * 메모리 전용 로그인 제한기. 차단 중(계정 또는 전역)에 들어온 실패는 기록하지 않는다 —
 * 그래야 차단이 풀린 뒤 새로 세고, 전역 차단 중 무작위 계정 키로 메모리가 커지지도 않는다.
 * 만료된 항목은 recordFailure 때마다 훑어서 지운다(전역 상한 덕에 항목 수는 작게 유지된다).
 */
export function createLoginLimiter(clock: Clock = Date.now, limits: typeof LOGIN_LIMITS = LOGIN_LIMITS): LoginLimiter {
  const accounts = new Map<string, FailureState>();
  let global: FailureState = EMPTY_STATE;

  const accountState = (key: string): FailureState => accounts.get(key) ?? EMPTY_STATE;

  const sweep = (now: number): void => {
    for (const [key, state] of accounts) {
      if (isExpired(state, now, limits.windowMs)) accounts.delete(key);
    }
  };

  const isAllowed = (accountKey: string): boolean => {
    const now = clock();
    return !isBlocked(global, now) && !isBlocked(accountState(accountKey), now);
  };

  const recordFailure = (accountKey: string): void => {
    const now = clock();
    sweep(now);
    if (!isAllowed(accountKey)) return;
    accounts.set(accountKey, addFailure(accountState(accountKey), now, limits.perAccount, limits));
    global = addFailure(global, now, limits.global, limits);
  };

  const recordSuccess = (accountKey: string): void => {
    accounts.delete(accountKey);
  };

  return Object.freeze({ isAllowed, recordFailure, recordSuccess });
}
