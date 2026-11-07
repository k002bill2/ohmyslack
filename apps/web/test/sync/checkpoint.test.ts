import { beforeEach, describe, expect, it } from 'vitest';
import { adoptAccount, clearCheckpoints, readCheckpoint, writeCheckpoint } from '../../src/features/sync';

beforeEach(() => {
  localStorage.clear();
});

describe('features/sync/checkpoint', () => {
  it('계정별 키 oms.cp.<userId>에 음이 아닌 정수 문자열만 저장한다', () => {
    writeCheckpoint('u1', 42);
    expect(localStorage.getItem('oms.cp.u1')).toBe('42');
    expect(readCheckpoint('u1')).toBe(42);
    writeCheckpoint('u1', 0);
    expect(readCheckpoint('u1')).toBe(0);
    expect(readCheckpoint('u2')).toBeNull();
  });

  it('숫자 외 값·음수·소수·안전 범위 밖·잘못된 계정 ID는 거부하고 아무것도 쓰지 않는다', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '7', { cursor: 1 }, null]) {
      expect(() => writeCheckpoint('u1', bad as number), String(bad)).toThrow(TypeError);
    }
    expect(() => writeCheckpoint('a.b', 1)).toThrow(TypeError);
    expect(() => writeCheckpoint('', 1)).toThrow(TypeError);
    expect(localStorage.length).toBe(0);
  });

  it('저장된 값이 숫자 문자열이 아니면 읽지 않고 지운다', () => {
    for (const raw of ['{"user":"u1","cursor":3}', '-1', '01', '1e3', ' 5', 'abc']) {
      localStorage.setItem('oms.cp.u1', raw);
      expect(readCheckpoint('u1'), raw).toBeNull();
      expect(localStorage.getItem('oms.cp.u1')).toBeNull();
    }
  });

  it('401·로그아웃 때 모든 checkpoint를 지우고, 다른 계정 로그인 때 그 계정 외 checkpoint를 지운다', () => {
    writeCheckpoint('u1', 1);
    writeCheckpoint('u2', 2);
    localStorage.setItem('unrelated', 'keep');
    adoptAccount('u2');
    expect(readCheckpoint('u1')).toBeNull();
    expect(readCheckpoint('u2')).toBe(2);
    clearCheckpoints();
    expect(readCheckpoint('u2')).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('keep');
  });

  it('저장소 접근이 막힌 환경(사설 모드 등)에서도 예외 없이 동작한다', () => {
    const broken = {
      length: 0,
      key: () => null,
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => writeCheckpoint('u1', 1, broken)).not.toThrow();
    expect(readCheckpoint('u1', broken)).toBeNull();
    expect(() => clearCheckpoints(broken)).not.toThrow();
  });
});
