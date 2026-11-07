// @vitest-environment node
/**
 * 전역 기본·로그인 전 화면 CSS 계약(DESIGN_REFERENCE §3-2, SCR-01·SCR-02). jsdom은 시각 상태를 못 보므로 소스 계약만 고정한다.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PUBLIC_SHELL, buildPrecacheEntries } from '../../vite.config.js';
import { mediaQueries, tokens } from '../../src/ui/tokens.js';

/** WCAG 2.x 대비(tools/check-design-tokens.ts와 같은 식 — 패키지 경계 밖이라 import하지 않는다). */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}
function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

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

  // 시안 03(W-11c): 카드·입력 면은 slate1(--bg-app), 화면 바탕은 slate2(--bg-sidebar). 이전 기대값 --bg-elevated 카드 → 시안 근거로 교체.
  it('카드는 --bg-app(바탕 --bg-sidebar), 제목 --text-xl, 입력·버튼 최소 44px, 오류 --danger-text, 링크 --accent-text', () => {
    expect(css).toMatch(/\.auth-card \{[^}]*background: var\(--bg-app\)/);
    expect(css).toMatch(/\.auth-screen \{[^}]*background: var\(--bg-sidebar\)/);
    expect(css).toContain('font-size: var(--text-xl)');
    expect(css.match(/min-height: 44px/g)).toHaveLength(2);
    expect(css).toMatch(/\[role='alert'\][^{]*\{[^}]*color: var\(--danger-text\)/);
    expect(css).toMatch(/\.auth-card a \{[^}]*color: var\(--accent-text\)/);
  });
});

describe('auth.css 글자 대비(§7-1 1.4.3, 두 스킴)', () => {
  const css = src('features/auth/auth.css');
  const ratio = (scheme: 'light' | 'dark', fg: string, bg: string): number => {
    const colors: Readonly<Record<string, { readonly value: string } | undefined>> = tokens.colors[scheme];
    const a = colors[fg]?.value;
    const b = colors[bg]?.value;
    if (a === undefined || b === undefined) throw new Error(`${scheme} ${fg}/${bg} 토큰 없음`);
    return contrast(a, b);
  };

  it('제출 버튼은 accent-bg 면 위 accent-text 글자다', () => {
    expect(css).toMatch(/button\[type='submit'\] \{[^}]*background: var\(--accent-bg\);\s*color: var\(--accent-text\)/);
  });

  it.each(['light', 'dark'] as const)('%s: 카드·입력(bg-elevated·bg-app)·버튼 위 글자 4.5:1 이상', (scheme) => {
    for (const fg of ['--text', '--text-muted', '--danger-text', '--accent-text']) {
      expect(ratio(scheme, fg, '--bg-elevated')).toBeGreaterThanOrEqual(4.5);
      expect(ratio(scheme, fg, '--bg-app')).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(scheme, '--accent-text', '--accent-bg')).toBeGreaterThanOrEqual(4.5);
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

describe('auth.css 오류 알림 면(시안 03 showError, W-11c)', () => {
  const css = src('features/auth/auth.css');
  /** srgb color-mix(p% a, b) — 채널별 선형 보간. */
  const mix = (a: string, b: string, p: number): string => {
    const ch = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
    const [ca, cb] = [ch(a), ch(b)];
    return `#${ca.map((v, i) => Math.round(v * p + (cb[i] ?? 0) * (1 - p)).toString(16).padStart(2, '0')).join('')}`;
  };

  it.each(['light', 'dark'] as const)('%s: danger-solid를 bg-app에 섞은 면 위 --danger-text 4.5:1 이상', (scheme) => {
    const m = /color-mix\(in srgb, var\(--danger-solid\) (\d+)%, var\(--bg-app\)\)/.exec(css);
    expect(m).not.toBeNull();
    const c = tokens.colors[scheme] as Readonly<Record<string, { readonly value: string } | undefined>>;
    const surface = mix(c['--danger-solid']?.value ?? '', c['--bg-app']?.value ?? '', Number(m?.[1]) / 100);
    expect(contrast(c['--danger-text']?.value ?? '', surface)).toBeGreaterThanOrEqual(4.5);
  });
});
