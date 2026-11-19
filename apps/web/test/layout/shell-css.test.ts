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

describe('스레드 작성기 하단 고정(R5 실렌더 834 — 시안 「중간 폭 · 2단 + 스레드 시트」)', () => {
  const refresh = readFileSync(fileURLToPath(new URL('../../src/features/layout/refresh.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  it('떠 있는 패널 여백 규칙이 margin-top: auto(패널 바닥으로 밀기)를 덮어쓰지 않는다', () => {
    const rule = [...refresh.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => (m[1] ?? '').trim() === ".app-shell:not([data-layout='compact']) .thread-panel > .composer")
      .at(-1)?.[2] ?? '';
    expect(rule).toMatch(/margin: auto var\(--space-3\) var\(--space-3\)/);
  });
  it('긴 스레드(패널 스크롤)에서도 sticky 작성기가 바닥 여백 space-3을 지킨다 — bottom 0이면 margin이 무시돼 패널 끝에 붙는다(운영 실렌더 834, 1px)', () => {
    const rule = [...refresh.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => (m[1] ?? '').trim() === ".app-shell:not([data-layout='compact']) .thread-panel > .composer")
      .at(-1)?.[2] ?? '';
    expect(rule).toMatch(/bottom: var\(--space-3\)/);
  });
});

describe('넓은 화면 폭(B1, 2026-11-16)·분할 손잡이 대비(A1)', () => {
  const refresh = readFileSync(fileURLToPath(new URL('../../src/features/layout/refresh.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  it('타임라인·작성기에 시안 읽기 폭 상한(800/830px)을 두지 않는다', () => {
    expect(refresh).not.toMatch(/100% - 800px/);
    expect(refresh).not.toMatch(/max-width: 830px/);
  });
  it('분할 손잡이는 조작 대상이라 장식 토큰이 아닌 --border(3:1)를 쓴다', () => {
    const rule = [...refresh.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => (m[1] ?? '').trim() === '.splitter-handle').at(-1)?.[2] ?? '';
    expect(rule).toContain('background: var(--border);');
  });
});

describe('분할 그리드 스레드 열 바닥 보장(N1·P3-3)', () => {
  const refresh = readFileSync(fileURLToPath(new URL('../../src/features/layout/refresh.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string) =>
    [...refresh.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => (m[1] ?? '').trim() === selector).at(-1)?.[2] ?? '';
  it('스레드 열 = minmax(--thread-min, --thread-w) — 본문 바닥을 먼저 지키고 남는 공간만큼만 사용자 폭', () => {
    for (const sel of [
      ".app-shell[data-split='on'][data-thread='open']",
      ".app-shell[data-split='on'][data-sidebar='collapsed'][data-thread='open']",
    ]) {
      expect(rule(sel)).toContain('minmax(calc(var(--body-min) - 4 * var(--space-3)), 1fr) var(--space-3) minmax(var(--thread-min), var(--thread-w))');
    }
  });
  it('분할 중 스레드 패널은 고정 폭 대신 열을 채운다', () => {
    expect(rule(".app-shell[data-split='on'] > .thread-wide")).toContain('width: auto');
  });
  it('--thread-min 토큰은 splitLimits.threadMin(320)과 같다', async () => {
    const { layoutVars, splitLimits } = await import('../../src/ui/tokens.js');
    expect(layoutVars['--thread-min']).toBe(`${splitLimits.threadMin}px`);
  });
});
