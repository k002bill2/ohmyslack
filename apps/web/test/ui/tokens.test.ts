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
  '--bg-app', '--bg-sidebar', '--bg-elevated', '--bg-hover', '--bg-active',
  '--border-subtle', '--border', '--text-muted', '--text',
  '--accent-solid', '--accent-text', '--accent-bg', '--success-text',
  '--warning-bg', '--warning-text', '--danger-bg', '--danger-text', '--danger-solid', '--focus-ring',
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
      ['--text', '--bg-sidebar'], ['--text', '--bg-elevated'], ['--text', '--bg-hover'], ['--text', '--bg-active'],
      ['--text-muted', '--bg-sidebar'], ['--text-muted', '--bg-elevated'], ['--text-muted', '--bg-hover'],
      ['--text-muted', '--bg-active'], ['--text', '--accent-bg'], ['--accent-text', '--accent-bg'],
      ['--danger-text', '--danger-bg'],
    ];
    for (const s of SCHEMES) {
      for (const [fg, bg] of pairs) {
        expect(ratio(tok(s, fg).value, tok(s, bg).value), `${s} ${fg} on ${bg}`)
          .toBeGreaterThanOrEqual(checker.MIN_CONTRAST_TEXT);
      }
    }
  });

  it('「여기부터 새 메시지」 라벨 테두리 danger-solid가 danger-bg 위에서 ≥ 3:1(§7-1 1.4.11)', () => {
    for (const s of SCHEMES) {
      expect(ratio(tok(s, '--danger-solid').value, tok(s, '--danger-bg').value), s)
        .toBeGreaterThanOrEqual(checker.MIN_CONTRAST_NONTEXT);
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

  it('lists fonts and icons with provenance', () => {
    expect(tokens.fonts.map((f) => f.name)).toEqual(['Pretendard', 'Noto Sans KR', 'JetBrains Mono']);
    expect(tokens.icons.every((i) => i.license === 'ISC')).toBe(true);
    expect(tokens.icons.map((i) => i.name)).toContain('hash');
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
