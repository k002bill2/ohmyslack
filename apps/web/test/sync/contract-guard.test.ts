/** QA P3-1 회귀: 늦게 도착한 계약 위반이 원인 테스트명과 함께 보고되고 유실되지 않는다(가드 순수 함수). */
import { describe, expect, it } from 'vitest';
import { AFTER_TEST, createViolationLog, formatViolations } from './contract-guard';

describe('계약 위반 기록(contract-guard)', () => {
  it('같은 테스트에서 난 위반은 그 테스트명과 함께 보고되고, drain 뒤에는 비어 있다', () => {
    let now: string | undefined = 'A 전송';
    const log = createViolationLog(() => now);
    log.record('POST x 201: change_id', 'A 전송');
    const error = log.drain();
    expect(error?.message).toContain('[A 전송] POST x 201: change_id');
    expect(log.drain()).toBeNull();
    now = undefined;
    expect(log.drain()).toBeNull();
  });

  it('누수 프로브: 테스트 A의 서버가 테스트 B 실행 중 위반하면 원인(A)과 기록 시점(B)을 모두 남긴다', () => {
    let now: string | undefined = 'B 다음 테스트';
    const log = createViolationLog(() => now);
    log.record('POST x 201: seq', 'A 누수 테스트');
    expect(log.drain()?.message).toContain('[원인: A 누수 테스트 / 기록 시점: B 다음 테스트] POST x 201: seq');
    now = undefined;
    log.record('PATCH y 200: message', 'A 누수 테스트');
    expect(log.drain()?.message).toContain(`[원인: A 누수 테스트 / 기록 시점: ${AFTER_TEST}] PATCH y 200: message`);
  });

  it('owner를 모르면 기록 시점 테스트(없으면 after-test)로 귀속한다', () => {
    const log = createViolationLog(() => undefined);
    log.record('d', undefined);
    expect(log.drain()?.message).toContain(`[${AFTER_TEST}] d`);
  });

  it('여러 위반을 한 오류로 모은다', () => {
    const msg = formatViolations([
      { detail: 'a', owner: 'T1', at: 'T1' },
      { detail: 'b', owner: 'T1', at: 'T2' },
    ]);
    expect(msg.split('\n')).toEqual(['fake-server 응답이 shared 계약과 다르다:', '[T1] a', '[원인: T1 / 기록 시점: T2] b']);
  });
});
