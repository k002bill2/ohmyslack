import { describe, expect, it } from 'vitest';
import {
  ARGON2_PARAMS,
  PASSWORD_MAX_CODE_POINTS,
  PASSWORD_MIN_CODE_POINTS,
  checkPasswordPolicy,
  hashPassword,
  normalizeEmail,
  verifyPassword,
} from '../../src/modules/auth/password.js';

/** TRD §5-1 S9 고정값. 정본 수치를 단언하는 유일한 곳이다. */
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const SAMPLE = 'correct horse battery staple';

function b64Length(segment: string): number {
  return Buffer.from(segment, 'base64').length;
}

describe('password hash (TRD §5-1 S9)', () => {
  it('파라미터는 argon2id m=19456 t=2 p=1 tag 32 salt 16 고정값이다', () => {
    expect(ARGON2_PARAMS).toEqual({ memory: 19456, passes: 2, parallelism: 1, tagLength: 32, saltLength: 16 });
  });

  it('PHC 문자열로 저장하고 같은 비밀번호로 왕복 검증된다', async () => {
    const phc = await hashPassword(SAMPLE);
    const match = PHC.exec(phc);
    expect(match).not.toBeNull();
    const [, m, t, p, salt, hash] = match ?? [];
    expect([m, t, p]).toEqual(['19456', '2', '1']);
    expect(salt?.includes('=')).toBe(false);
    expect(b64Length(salt ?? '')).toBe(16);
    expect(b64Length(hash ?? '')).toBe(32);
    expect(phc.includes(SAMPLE)).toBe(false);
    await expect(verifyPassword(SAMPLE, phc)).resolves.toBe(true);
    await expect(verifyPassword(`${SAMPLE}!`, phc)).resolves.toBe(false);
  });

  it('같은 비밀번호도 salt가 달라 해시가 매번 다르다', async () => {
    const [a, b] = await Promise.all([hashPassword(SAMPLE), hashPassword(SAMPLE)]);
    expect(a).not.toBe(b);
  });

  it('변조·형식 오류·다른 알고리즘 해시는 예외 없이 false다', async () => {
    const phc = await hashPassword(SAMPLE);
    const parts = phc.split('$');
    const tag = parts[5] ?? '';
    const flipped = `${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`;
    const tampered = [...parts.slice(0, 5), flipped].join('$');
    const cases = [
      tampered,
      phc.replace('m=19456', 'm=19457'),
      phc.replace('$argon2id$', '$argon2i$'),
      phc.replace('v=19', 'v=16'),
      phc.replace(',t=2,', ',t=0,'),
      phc.replace('m=19456', 'm=99999999'),
      `${phc}$extra`,
      parts.slice(0, 5).join('$'),
      '',
      'plaintext',
    ];
    for (const stored of cases) await expect(verifyPassword(SAMPLE, stored)).resolves.toBe(false);
  });
});

describe('password policy (12–128 code point)', () => {
  const repeat = (unit: string, count: number): string => unit.repeat(count);

  it('경계값: 11 거부·12 허용·128 허용·129 거부', () => {
    expect(PASSWORD_MIN_CODE_POINTS).toBe(12);
    expect(PASSWORD_MAX_CODE_POINTS).toBe(128);
    expect(checkPasswordPolicy(repeat('a', 11)).ok).toBe(false);
    expect(checkPasswordPolicy(repeat('a', 12)).ok).toBe(true);
    expect(checkPasswordPolicy(repeat('a', 128)).ok).toBe(true);
    expect(checkPasswordPolicy(repeat('a', 129)).ok).toBe(false);
  });

  it('이모지는 UTF-16 길이가 아니라 code point로 센다', () => {
    const emoji = '🔐';
    expect(checkPasswordPolicy(repeat(emoji, 11)).ok).toBe(false);
    expect(checkPasswordPolicy(repeat(emoji, 12)).ok).toBe(true);
    expect(checkPasswordPolicy(repeat(emoji, 128)).ok).toBe(true);
    expect(checkPasswordPolicy(repeat(emoji, 129)).ok).toBe(false);
  });

  it('거부 사유에 비밀번호 원문을 담지 않는다', () => {
    const secret = 'short-pw';
    const result = checkPasswordPolicy(secret);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result).includes(secret)).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('trim + NFC + 소문자', () => {
    expect(normalizeEmail('  Alice@Example.COM \n')).toBe('alice@example.com');
    expect(normalizeEmail('Café@x.io')).toBe('café@x.io');
  });
});
