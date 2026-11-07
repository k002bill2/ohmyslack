// @vitest-environment node
/**
 * Pretendard v1.3.9 공식 웹 빌드 동봉 고정(DESIGN_REFERENCE §3-1: 무수정·고지 동봉·버전 기록).
 * 파일을 바꾸면(서브셋·변환 포함) 해시가 달라져 실패한다.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fontsDir = fileURLToPath(new URL('../../public/fonts/', import.meta.url));
const read = (name: string) => readFileSync(`${fontsDir}${name}`);
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

describe('public/fonts Pretendard 동봉', () => {
  it('PretendardVariable.woff2는 v1.3.9 릴리스 파일 그대로다', () => {
    const buf = read('PretendardVariable.woff2');
    expect(buf.length).toBe(2_057_688);
    expect(sha256(buf)).toBe('9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4');
  });

  it('OFL 1.1 고지(LICENSE.txt)를 원본 그대로 동봉한다', () => {
    const buf = read('LICENSE.txt');
    expect(sha256(buf)).toBe('b04538c9abec39a3db75108cf0af0fd9c77032fe8aa2cf38345b4d250e98e38e');
    expect(buf.toString('utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('SOURCES.md에 릴리스·URL·해시·무수정을 기록한다', () => {
    const text = read('SOURCES.md').toString('utf8');
    expect(text).toContain('v1.3.9');
    expect(text).toContain('https://github.com/orioncactus/pretendard/releases/download/v1.3.9/Pretendard-1.3.9.zip');
    expect(text).toContain('04be351a74d6bf7d60c480a3087e51d185485d35a52023142af1df19eb8c428a');
    expect(text).toContain('9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4');
    expect(text).toContain('b04538c9abec39a3db75108cf0af0fd9c77032fe8aa2cf38345b4d250e98e38e');
    expect(text).toContain('무수정');
  });

  it('폰트 디렉터리에는 동봉 3파일만 있다', () => {
    expect(readdirSync(fontsDir).sort()).toEqual(['LICENSE.txt', 'PretendardVariable.woff2', 'SOURCES.md']);
  });
});
