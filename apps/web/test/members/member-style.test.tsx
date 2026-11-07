// @vitest-environment node
/** 시안 10(W-11c) 멤버 행 이니셜: 첫 글자(서로게이트 안전, 영문 대문자). 행 텍스트에는 섞지 않는다(CSS attr). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { memberInitial } from '../../src/features/members/MemberAdmin.js';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8');

describe('memberInitial', () => {
  it('한글·영문·이모지 첫 글자, 공백만이면 빈 문자열', () => {
    expect(memberInitial('강영환')).toBe('강');
    expect(memberInitial(' alice')).toBe('A');
    expect(memberInitial('😀 smile')).toBe('😀');
    expect(memberInitial('   ')).toBe('');
  });
});

describe('members.css', () => {
  const css = src('features/members/members.css');
  it('members 공개 API가 members.css를 import하고, 이니셜은 attr(data-initial)로 그린다', () => {
    expect(src('features/members/index.ts')).toContain("import './members.css'");
    expect(css).toMatch(/\.member-avatar::before \{[^}]*content: attr\(data-initial\)/);
  });
  it('색은 토큰 변수만 쓴다(hex·rgb 리터럴 없음), 경고는 warning 토큰', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(css).toMatch(/\.invite-warning \{[^}]*background: var\(--warning-bg\);[^}]*color: var\(--warning-text\)/);
  });
});
