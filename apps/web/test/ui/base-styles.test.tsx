// @vitest-environment node
/**
 * 전역 기본·로그인 전 화면 CSS 계약(DESIGN_REFERENCE §3-2, SCR-01·SCR-02). jsdom은 시각 상태를 못 보므로 소스 계약만 고정한다.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PUBLIC_SHELL, buildPrecacheEntries } from '../../vite.config.js';
import { mediaQueries } from '../../src/ui/tokens.js';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8');

describe('base.css', () => {
  const css = src('ui/base.css');

  it('Pretendard Variable @font-face 1개를 swap·가변 굵기로 선언한다', () => {
    expect(css.match(/@font-face/g)).toHaveLength(1);
    expect(css).toContain('font-family: "Pretendard Variable"');
    expect(css).toContain('url("/fonts/PretendardVariable.woff2") format("woff2-variations")');
    expect(css).toContain('url("/fonts/PretendardVariable.woff2") format("woff2")');
    expect(css).toContain('font-weight: 45 920');
    expect(css).toContain('font-display: swap');
  });

  it('html·body에 토큰 배경·글자색·글꼴과 color-scheme을 건다', () => {
    const rule = /html,\s*body\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    for (const decl of [
      'background: var(--bg-app)',
      'color: var(--text)',
      'font-family: var(--font-sans)',
      '-webkit-text-size-adjust: 100%',
      'color-scheme: light dark',
    ]) expect(rule).toContain(decl);
  });

  it('main.tsx가 토큰 CSS 다음에 base.css를 import한다', () => {
    const main = src('main.tsx');
    expect(main.indexOf("import './ui/base.css'")).toBeGreaterThan(main.indexOf("import 'virtual:tokens.css'"));
  });
});

describe('auth.css', () => {
  const css = src('features/auth/auth.css');

  it('features/auth 공개 API가 auth.css를 import한다', () => {
    expect(src('features/auth/index.ts')).toContain("import './auth.css'");
  });

  it('compact 경계는 tokens.ts mediaQueries.compact와 같다', () => {
    expect(css).toContain(`@media ${mediaQueries.compact} {`);
  });

  it('색은 토큰 변수만 쓴다(hex·rgb 리터럴 없음)', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(src('ui/base.css')).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  it('카드는 --bg-elevated, 제목 --text-xl, 입력·버튼 최소 44px, 오류 --danger-text, 링크 --accent-text', () => {
    expect(css).toContain('background: var(--bg-elevated)');
    expect(css).toContain('font-size: var(--text-xl)');
    expect(css.match(/min-height: 44px/g)).toHaveLength(2);
    expect(css).toMatch(/\[role='alert'\][^{]*\{[^}]*color: var\(--danger-text\)/);
    expect(css).toMatch(/\.auth-card a \{[^}]*color: var\(--accent-text\)/);
  });
});

describe('폰트는 SW precache 대상이 아니다', () => {
  it('PUBLIC_SHELL에 fonts/ 항목이 없다', () => {
    expect(PUBLIC_SHELL.filter((name) => name.startsWith('fonts/'))).toEqual([]);
  });

  it('번들에 fonts/ 파일이 섞여도 목록에 넣지 않는다', () => {
    const entries = buildPrecacheEntries({ 'fonts/PretendardVariable.woff2': 'x', 'index.html': '<html>' }, {});
    expect(entries.map((e) => e.url)).toEqual(['/index.html']);
  });
});
