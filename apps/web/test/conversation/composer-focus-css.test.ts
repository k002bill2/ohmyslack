// @vitest-environment node
/**
 * 작성기 포커스 표시(D §7-1 2.4.7 「2px 링 + 2px 오프셋」, UI_STATES §4-1 `--focus-ring`).
 * textarea 자체는 링을 끄고(작성기 상자 안의 입력) 감싼 `.composer`가 같은 링을 그린다 — W-16 QA F-4.
 * jsdom은 레이아웃이 없어 소스 규칙만 고정한다(shell-css.test.ts와 같은 방식).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../../src/features/conversation/conversation.css', import.meta.url)), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const last = (selector: string) => {
  const hits = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => (m[1] ?? '').trim() === selector);
  return hits.at(-1)?.[2] ?? '';
};

describe('FR-CLIENT-07 작성기 포커스 링', () => {
  it('작성기에 키보드 포커스가 오면 감싼 상자가 전역 포커스 링과 같은 2px 링 + 2px 오프셋을 그린다', () => {
    const rule = last('.composer:has(.composer-input:focus-visible)');
    expect(rule).toContain('outline: 2px solid var(--focus-ring)');
    expect(rule).toContain('outline-offset: 2px');
  });
});
