// @vitest-environment node
/** W-10l 패널별 스크롤·배너 행 고정 CSS 계약(jsdom은 레이아웃이 없어 소스 계약만 고정한다). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8');
const rule = (css: string, selector: string) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1] ?? '').join('\n');
};
const layout = read('features/layout/layout.css');
const conversation = read('features/conversation/conversation.css');

describe('패널별 스크롤(UI_STATES §3, D §5)', () => {
  it('셸 = 화면 높이(100dvh, 100vh 폴백) + 문서 스크롤 없음 + 배너 행/패널 행 분리', () => {
    const shell = rule(layout, '.app-shell');
    expect(shell).toMatch(/height: 100vh;\s*height: 100dvh;/);
    expect(shell).toContain('overflow: hidden');
    expect(shell).toContain('grid-template-rows: auto minmax(0, 1fr)');
    expect(rule(layout, '.app-shell > :not(.connection-banner)')).toContain('grid-row: 2');
    expect(rule(layout, '.connection-banner')).toContain('grid-row: 1');
  });

  it('목록만 스크롤: 메시지 목록·사이드바 목록·스레드·멤버 관리·공간 화면', () => {
    expect(rule(layout, '.conversation-pane > .message-list')).toMatch(/min-height: 0;[\s\S]*overflow-y: auto/);
    expect(rule(layout, '.sidebar > .space-list,\n.sidebar > .empty-state')).toContain('overflow-y: auto');
    expect(rule(layout, '.thread-panel')).toContain('overflow-y: auto');
    expect(rule(layout, '.member-admin-screen')).toContain('overflow-y: auto');
    expect(rule(layout, '.space-screen')).toContain('overflow-y: auto');
  });

  it('작성기 하단 safe-area 여백', () => {
    expect(rule(conversation, '.composer')).toContain('padding-bottom: calc(var(--space-3) + env(safe-area-inset-bottom))');
  });
});
