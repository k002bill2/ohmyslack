// @vitest-environment node
/**
 * W-11a 카드 셸 CSS 계약(Codex r1 P2): 셸 패딩·패널 여백을 더해도 열 최소 폭 합이 정본 구간 경계를 넘지 않는다.
 * jsdom은 레이아웃이 없어 소스 규칙만 고정한다.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../../src/features/layout/layout.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** 같은 선택자 규칙이 여럿이면 마지막(캐스케이드 승자). */
const last = (selector: string) => {
  const hits = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => (m[1] ?? '').trim() === selector);
  return hits.at(-1)?.[2] ?? '';
};

describe('카드 셸 열 폭(시안 01·09)', () => {
  it('medium 본문 최소 폭 = 정본 - (셸 패딩 2 + 패널 여백 1) × space-3', () => {
    expect(last(".app-shell[data-layout='medium']")).toContain('minmax(calc(var(--body-min-medium) - 3 * var(--space-3)), 1fr)');
  });
  it('wide(펼침·접힘) 본문 최소 폭 = 정본 - (셸 패딩 2 + 본문·스레드 여백 2) × space-3', () => {
    for (const sel of [".app-shell[data-layout='wide']", ".app-shell[data-layout='wide'][data-sidebar='collapsed']"]) {
      expect(last(sel)).toContain('minmax(calc(var(--body-min) - 4 * var(--space-3)), 1fr) auto');
    }
  });
  it('접힌 사이드바 항목은 간격·안쪽 여백을 space-1로 줄인다', () => {
    const item = last(".sidebar[data-collapsed='true'] .space-item");
    expect(item).toContain('gap: var(--space-1)');
    expect(item).toContain('padding: 0 var(--space-1)');
  });
});

describe('알림 탭 대상 없음 안내(W-23b Codex 확인 라운드 P2)', () => {
  it('스레드 패널은 자체 스크롤이라 안내를 위쪽 sticky로 고정한다 — 맨 아래로 이동한 뒤에도 보이게', () => {
    const rule = last('.thread-panel > .message-anchor-notice');
    expect(rule).toContain('position: sticky');
    expect(rule).toContain('top: 0');
  });
});
