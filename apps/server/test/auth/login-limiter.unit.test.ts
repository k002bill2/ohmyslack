import { beforeEach, describe, expect, it } from 'vitest';
import { createLoginLimiter, LOGIN_LIMITS, type LoginLimiter } from '../../src/modules/auth/login-limiter.js';

const MINUTE = 60_000;
let now = 1_000_000;
let limiter: LoginLimiter;

function fail(key: string, times: number): void {
  for (let i = 0; i < times; i += 1) limiter.recordFailure(key);
}

beforeEach(() => {
  now = 1_000_000;
  limiter = createLoginLimiter(() => now);
});

/** 계정별 제한(TRD §5-1 S1): 15분 창 안 실패 5회 → 15분 차단. */
describe('login limiter per-account', () => {
  it('실패 4회까지는 허용된다', () => {
    fail('a@x', 4);
    expect(limiter.isAllowed('a@x')).toBe(true);
  });

  it('5번째 실패에서 차단되고 6번째 시도도 막힌다', () => {
    fail('a@x', 5);
    expect(limiter.isAllowed('a@x')).toBe(false);
    limiter.recordFailure('a@x');
    expect(limiter.isAllowed('a@x')).toBe(false);
  });

  it('정확히 15분이 지나면 다시 허용되고 새로 센다', () => {
    fail('a@x', 5);
    now += LOGIN_LIMITS.blockMs - 1;
    expect(limiter.isAllowed('a@x')).toBe(false);
    now += 1;
    expect(limiter.isAllowed('a@x')).toBe(true);
    fail('a@x', 4);
    expect(limiter.isAllowed('a@x')).toBe(true);
  });

  it('창(15분) 밖으로 벌어진 실패는 누적되지 않는다', () => {
    fail('a@x', 4);
    now += LOGIN_LIMITS.windowMs;
    fail('a@x', 4);
    expect(limiter.isAllowed('a@x')).toBe(true);
  });

  it('성공하면 그 계정의 실패 카운트가 초기화된다', () => {
    fail('a@x', 4);
    limiter.recordSuccess('a@x');
    fail('a@x', 4);
    expect(limiter.isAllowed('a@x')).toBe(true);
  });

  it('한 계정의 차단은 다른 계정에 영향이 없다(전역 임계치 미만)', () => {
    fail('a@x', 5);
    expect(limiter.isAllowed('a@x')).toBe(false);
    expect(limiter.isAllowed('b@x')).toBe(true);
  });

  it('차단 중 실패는 기록하지 않아 해제 직후 다시 막히지 않는다', () => {
    fail('a@x', 5);
    now += 10 * MINUTE;
    fail('a@x', 10);
    now += 5 * MINUTE;
    limiter.recordFailure('a@x');
    expect(limiter.isAllowed('a@x')).toBe(true);
  });
});

/** 전역 제한: 모든 계정(미존재 포함) 합산 실패 20회 → 모든 로그인 15분 차단. */
describe('login limiter global', () => {
  function failDistinct(count: number): void {
    for (let i = 0; i < count; i += 1) limiter.recordFailure(`user${i}@x`);
  }

  it('서로 다른 계정 실패 20회면 새 계정까지 모두 막히고 15분 뒤 풀린다', () => {
    failDistinct(19);
    expect(limiter.isAllowed('fresh@x')).toBe(true);
    failDistinct(1);
    expect(limiter.isAllowed('fresh@x')).toBe(false);
    expect(limiter.isAllowed('user0@x')).toBe(false);
    now += LOGIN_LIMITS.blockMs;
    expect(limiter.isAllowed('fresh@x')).toBe(true);
  });

  it('recordSuccess는 전역 차단을 풀지 않는다', () => {
    failDistinct(20);
    limiter.recordSuccess('user0@x');
    limiter.recordSuccess('fresh@x');
    expect(limiter.isAllowed('user0@x')).toBe(false);
    expect(limiter.isAllowed('fresh@x')).toBe(false);
  });
});
