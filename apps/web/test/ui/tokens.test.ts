import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildTokensCss } from '../../src/ui/tokens.css.js';
import { ROLE_TOKEN_NAMES, tokens, type ColorToken } from '../../src/ui/tokens.js';

/** 게이트와 같은 계산을 쓰려고 tools/check-design-tokens.ts를 런타임에 읽는다(읽기 전용, 패키지 경계 밖이라 타입은 최소). */
interface Checker {
  checkTokens(t: unknown): string[];
  contrastRatio(a: readonly number[], b: readonly number[]): number;
  parseHex(v: unknown): readonly [number, number, number] | undefined;
  isForbiddenSurface(rgb: readonly number[]): boolean;
  MIN_CONTRAST_TEXT: number;
  MIN_CONTRAST_NONTEXT: number;
}
const CHECKER = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../tools/check-design-tokens.ts');
let checker: Checker;
beforeAll(async () => {
  checker = (await import(pathToFileURL(CHECKER).href)) as Checker;
});

/** §3-3 역할 표 이름 정본(테스트 쪽 독립 사본). */
const CANON_ROLE_NAMES = [
  '--bg-app', '--bg-sidebar', '--bg-elevated', '--bg-hover', '--bg-hover-strong', '--bg-active',
  '--border-subtle', '--border', '--text-muted', '--text',
  '--accent-solid', '--accent-text', '--accent-bg', '--success-text',
  '--warning-bg', '--warning-text', '--danger-bg', '--danger-text', '--danger-solid',
  '--accent-strong', '--on-accent-strong', '--danger-strong', '--on-danger-strong', '--danger-line', '--mention-text',
  '--focus-ring',
  '--file-tile-green', '--on-file-tile-green', '--file-tile-blue', '--on-file-tile-blue',
  '--file-tile-orange', '--on-file-tile-orange', '--file-tile-red', '--on-file-tile-red',
  '--file-tile-cyan', '--on-file-tile-cyan', '--file-tile-neutral', '--on-file-tile-neutral',
];
const SCHEMES = ['light', 'dark'] as const;

function tok(scheme: 'light' | 'dark', name: string): ColorToken {
  const t = tokens.colors[scheme][name];
  if (t === undefined) throw new Error(`${scheme}.${name} 없음`);
  return t;
}

function ratio(fg: string, bg: string): number {
  const [a, b] = [checker.parseHex(fg), checker.parseHex(bg)];
  if (a === undefined || b === undefined) throw new Error(`hex 아님: ${fg} ${bg}`);
  return checker.contrastRatio(a, b);
}

describe('design tokens (DESIGN_REFERENCE §3·§7-1)', () => {
  it('has every canon role token name in both schemes', () => {
    expect([...ROLE_TOKEN_NAMES]).toEqual(CANON_ROLE_NAMES);
    for (const s of SCHEMES) expect(Object.keys(tokens.colors[s])).toEqual(CANON_ROLE_NAMES);
  });

  // 2026-11-23 영환님 지시 #F8F8F8 → 최근접 오픈 값 Radix gray2. elevated 면 위는 --bg-hover-strong. 스레드 패널 면은 --bg-app이라 별도 hover 토큰 없음.
  it('라이트 hover 면은 Radix gray2(#f9f9f9), 다크는 slate3 유지', () => {
    expect(tok('light', '--bg-hover').value).toBe('#f9f9f9');
    expect(tok('light', '--bg-hover').scale).toBe('gray');
    expect(tok('dark', '--bg-hover').scale).toBe('slate');
  });

  it('--bg-hover-strong은 elevated·hover와 다르고, hover는 app·sidebar와 다르다', () => {
    for (const s of SCHEMES) {
      expect(tok(s, '--bg-hover-strong').value, s).not.toBe(tok(s, '--bg-elevated').value);
      expect(tok(s, '--bg-hover-strong').value, s).not.toBe(tok(s, '--bg-hover').value);
      expect(tok(s, '--bg-hover').value, s).not.toBe(tok(s, '--bg-sidebar').value);
      expect(tok(s, '--bg-hover').value, s).not.toBe(tok(s, '--bg-app').value);
    }
  });

  it('light and dark have identical key sets', () => {
    expect(Object.keys(tokens.colors.light).sort()).toEqual(Object.keys(tokens.colors.dark).sort());
  });

  it('passes the check:design-tokens rules (provenance, forbidden surface, contrast)', () => {
    expect(checker.checkTokens(tokens)).toEqual([]);
  });

  it('meets contrast thresholds against the declared background', () => {
    for (const s of SCHEMES) {
      for (const [name, t] of Object.entries(tokens.colors[s])) {
        if (t.role === 'surface') continue;
        const min = t.role === 'text' ? checker.MIN_CONTRAST_TEXT : checker.MIN_CONTRAST_NONTEXT;
        expect(t.on, `${s}.${name}.on`).toBeDefined();
        expect(ratio(t.value, tok(s, t.on ?? '').value), `${s}.${name}`).toBeGreaterThanOrEqual(min);
      }
    }
  });

  it('text tokens stay ≥ 4.5:1 on the other canon backgrounds they are used on', () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['--text', '--bg-sidebar'], ['--text', '--bg-elevated'], ['--text', '--bg-hover'], ['--text', '--bg-hover-strong'], ['--text', '--bg-active'],
      ['--text-muted', '--bg-sidebar'], ['--text-muted', '--bg-elevated'], ['--text-muted', '--bg-hover'], ['--text-muted', '--bg-hover-strong'],
      ['--text-muted', '--bg-active'], ['--text', '--accent-bg'], ['--accent-text', '--accent-bg'],
      ['--danger-text', '--danger-bg'], ['--mention-text', '--bg-app'],
    ];
    for (const s of SCHEMES) {
      for (const [fg, bg] of pairs) {
        expect(ratio(tok(s, fg).value, tok(s, bg).value), `${s} ${fg} on ${bg}`)
          .toBeGreaterThanOrEqual(checker.MIN_CONTRAST_TEXT);
      }
    }
  });

  it('has no surface token in the forbidden hue zone (§2-3 3항)', () => {
    for (const s of SCHEMES) {
      const bad = Object.entries(tokens.colors[s])
        .filter(([, t]) => t.role === 'surface')
        .filter(([, t]) => checker.isForbiddenSurface(checker.parseHex(t.value) ?? [0, 0, 0]));
      expect(bad.map(([n]) => n), s).toEqual([]);
    }
  });

  it('records a reason whenever a step departs from the canon table', () => {
    for (const s of SCHEMES) {
      for (const [name, t] of Object.entries(tokens.colors[s])) {
        if (t.step !== t.canonStep) expect(t.deviation, `${s}.${name}`).toMatch(/</);
        else expect(t.deviation, `${s}.${name}`).toBeUndefined();
      }
    }
  });

  it('maps the R5 design surfaces: dark panel slate2 on a slate1 ground, light panel slate1 on slate3', () => {
    expect(tok('light', '--bg-app').value).toBe('#fcfcfd');
    expect(tok('light', '--bg-elevated').value).toBe('#f0f0f3');
    expect(tok('dark', '--bg-app').value).toBe('#18191b');
    expect(tok('dark', '--bg-elevated').value).toBe('#111113');
  });

  it('keeps decorative borders at the R5 design slate6 and control boundaries at 3:1 (§2-3 4항 예외, A1)', () => {
    for (const scheme of ['light', 'dark'] as const) {
      expect(tok(scheme, '--border-subtle')).toMatchObject({ role: 'surface', scale: 'slate', step: 6 });
      expect(tok(scheme, '--border')).toMatchObject({ role: 'nontext', step: 9 });
    }
  });

  it('gives solid buttons white text in light (Open Color) and slate1 text in dark', () => {
    expect(tok('light', '--accent-strong').value).toBe('#008573');
    expect(tok('light', '--on-accent-strong')).toMatchObject({ value: '#ffffff', scale: 'open-color' });
    expect(tok('dark', '--accent-strong').value).toBe('#12a594');
    expect(tok('dark', '--on-accent-strong').value).toBe('#111113');
    expect(tok('light', '--danger-strong').value).toBe('#ce2c31');
    expect(tok('dark', '--danger-strong').value).toBe('#e5484d');
    expect(tok('dark', '--mention-text').value).toBe('#0bd8b6');
  });

  it('lists fonts and icons with provenance', () => {
    expect(tokens.fonts.map((f) => f.name)).toEqual(['Pretendard', 'Noto Sans KR', 'JetBrains Mono']);
    expect(tokens.icons.every((i) => i.license === 'ISC')).toBe(true);
    expect(tokens.icons.map((i) => i.name)).toContain('hash');
    expect(tokens.icons.map((i) => i.name)).toEqual(expect.arrayContaining(['copy', 'check', 'x']));
  });
});

describe('buildTokensCss', () => {
  const css = buildTokensCss();

  it('emits light role tokens under :root and dark ones under prefers-color-scheme: dark', () => {
    const [light, rest] = css.split('@media (prefers-color-scheme: dark)');
    for (const name of CANON_ROLE_NAMES) {
      expect(light).toContain(`${name}: ${tok('light', name).value};`);
      expect(rest).toContain(`${name}: ${tok('dark', name).value};`);
    }
  });

  it('emits §3-2/§3-5 scalar tokens and reduced-motion overrides', () => {
    expect(css).toContain('--text-md: 0.9375rem;');
    expect(css).toContain('--space-10: 2.5rem;');
    expect(css).toContain('--radius-lg: 12px;');
    expect(css).toContain('--shadow-popover: 0 4px 16px rgb(0 0 0 / 0.12);');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*:root \{\s*--motion-fast: 0ms;\s*--motion-base: 0ms;/);
  });
});
