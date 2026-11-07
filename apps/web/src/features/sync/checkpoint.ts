/**
 * sync checkpoint — DEV_DESIGN §2-2 B7 예외: 이 파일만 localStorage를 쓴다. 값은 **음이 아닌 정수 문자열만**,
 * 키는 `oms.cp.<userId>`(계정 결속). TRD S11: 401·로그아웃·다른 계정 로그인 시 삭제.
 */

export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'oms.cp.';
const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DIGITS = /^(0|[1-9][0-9]*)$/;

function defaultStorage(): StorageLike | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function keyFor(userId: string): string {
  if (!USER_ID.test(userId)) throw new TypeError('checkpoint: 잘못된 계정 ID');
  return `${PREFIX}${userId}`;
}

function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** 음이 아닌 안전 정수만 저장한다. 그 외 값은 TypeError(아무것도 쓰지 않음). */
export function writeCheckpoint(userId: string, cursor: number, storage: StorageLike | null = defaultStorage()): void {
  const key = keyFor(userId);
  if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0) {
    throw new TypeError('checkpoint: 음이 아닌 정수만 저장합니다');
  }
  const value = String(cursor);
  if (!DIGITS.test(value)) throw new TypeError('checkpoint: 음이 아닌 정수만 저장합니다');
  attempt(() => storage?.setItem(key, value), undefined);
}

/** 저장된 값이 숫자 문자열이 아니면 지우고 null. */
export function readCheckpoint(userId: string, storage: StorageLike | null = defaultStorage()): number | null {
  const key = keyFor(userId);
  const raw = attempt(() => storage?.getItem(key) ?? null, null);
  if (raw === null) return null;
  const value = Number(raw);
  if (DIGITS.test(raw) && Number.isSafeInteger(value)) return value;
  attempt(() => storage?.removeItem(key), undefined);
  return null;
}

function removeWhere(storage: StorageLike | null, drop: (key: string) => boolean): void {
  if (storage === null) return;
  const keys = attempt(() => Array.from({ length: storage.length }, (_, i) => storage.key(i) ?? ''), [] as string[]);
  for (const key of keys) {
    if (key.startsWith(PREFIX) && drop(key)) attempt(() => storage.removeItem(key), undefined);
  }
}

/** 401·로그아웃: 모든 계정의 checkpoint를 지운다. */
export function clearCheckpoints(storage: StorageLike | null = defaultStorage()): void {
  removeWhere(storage, () => true);
}

/** 로그인 성공 시: 이 계정 외 checkpoint를 지운다(계정 전환). */
export function adoptAccount(userId: string, storage: StorageLike | null = defaultStorage()): void {
  const own = keyFor(userId);
  removeWhere(storage, (key) => key !== own);
}
