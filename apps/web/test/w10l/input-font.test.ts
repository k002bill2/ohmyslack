// @vitest-environment node
/**
 * iOS Safari는 글자 크기 16px 미만 입력에 포커스하면 화면을 확대한 채 둔다(iPhone 잘림 근거).
 * 입력 계열 선택자를 가진 모든 CSS 규칙은 글자 크기를 1rem 이상으로 고정해야 한다(Jarvis 결정 1). 사용자 확대는 막지 않는다.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tokens } from '../../src/ui/tokens.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const CSS_FILES = [
  'src/features/layout/layout.css',
  'src/features/conversation/conversation.css',
  'src/features/auth/auth.css',
];
const INPUT = /(^|[\s,>])(input|textarea|select)(?![\w-])|\.field(?![\w-])|\.composer-input(?![\w-])/;
const ROOT_PX = 16;

/** `max(1rem, var(--text-md))` / `1rem` / `var(--text-*)`를 px로. 해석 못 하면 NaN. */
function px(value: string): number {
  const v = value.trim();
  const max = /^max\((.*)\)$/.exec(v);
  if (max) return Math.max(...(max[1] ?? '').split(/,(?![^(]*\))/).map(px));
  const rem = /^([\d.]+)rem$/.exec(v);
  if (rem) return Number(rem[1]) * ROOT_PX;
  const token = /^var\((--[\w-]+)\)$/.exec(v);
  if (token) return px(String(tokens.typography[token[1] ?? ''] ?? 'NaN'));
  return Number.NaN;
}

function inputRules(css: string) {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: (m[1] ?? '').trim(), decls: m[2] ?? '' }))
    .filter((r) => !r.selector.startsWith('@') && INPUT.test(r.selector) && /(^|;)\s*font(-size)?\s*:/.test(r.decls));
}

describe('입력 글자 크기 ≥ 16px(iOS 포커스 확대 방지)', () => {
  it('index.html은 사용자 확대를 막지 않고 viewport-fit=cover를 쓴다', () => {
    const meta = /<meta name="viewport" content="([^"]+)"/.exec(read('index.html'))?.[1] ?? '';
    expect(meta).toContain('viewport-fit=cover');
    expect(meta).not.toMatch(/maximum-scale|user-scalable/);
  });

  for (const file of CSS_FILES) {
    it(`${file}: font를 정하는 입력 규칙마다 마지막 font-size ≥ 16px`, () => {
      const rules = inputRules(read(file));
      expect(rules.length).toBeGreaterThan(0);
      for (const { selector, decls } of rules) {
        const sizes = [...decls.matchAll(/font-size\s*:\s*([^;]+);?/g)].map((m) => m[1] ?? '');
        const last = sizes[sizes.length - 1];
        expect(last, `${selector}: font-size 없음(font: inherit만 있으면 15px 상속)`).toBeDefined();
        expect(px(last ?? ''), `${selector}: ${last}`).toBeGreaterThanOrEqual(ROOT_PX);
      }
    });
  }
});
