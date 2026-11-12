// @vitest-environment node
/**
 * menu-bots-touch-focus: 봇 추가·제거가 「대화 더보기」 메뉴로 옮겨 가 머리 봇 버튼 줄이 없어졌다.
 * QA D-1·header-390에서 넣은 머리 봇 줄 전용 CSS(가로 스크롤·두 줄 머리)는 죽은 규칙이라 지웠고, 390 머리는 봇 채널도 한 줄이다.
 * jsdom은 레이아웃이 없어 layout.css 소스에 두 줄 규칙이 남지 않았는지만 고정한다(높이 60px 실측은 재QA).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as membership from '../../src/features/conversation-membership/index.js';

const css = readFileSync(fileURLToPath(new URL('../../src/features/layout/layout.css', import.meta.url)), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const rules = (selector: string) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? '').trim() === selector)
    .map((m) => m[2] ?? '')
    .join('\n');

describe('머리 봇 줄 제거(menu-bots-touch-focus)', () => {
  it('머리 봇 컨트롤 CSS가 남지 않고 머리에는 줄바꿈 규칙이 없다(390 봇 채널도 한 줄)', () => {
    expect(css).not.toContain('bot-channel-control');
    expect(rules('.conversation-header')).not.toContain('flex-wrap');
    // Tab 순서 = 화면 순서: order로 시각 배치를 DOM과 다르게 하지 않는다.
    expect(css).not.toMatch(/\border\s*:/);
  });

  it('머리 버튼 컴포넌트는 공개 API에서 빠지고 메뉴 훅만 남는다', () => {
    expect(Object.keys(membership)).not.toContain('BotChannelControl');
    expect(typeof membership.useBotChannelMenu).toBe('function');
  });

  it('Codex r1 P2: 봇 항목이 많아도 머리 메뉴는 높이 상한 + 세로 스크롤(대화 영역 밖으로 잘리지 않게)', () => {
    const refresh = readFileSync(fileURLToPath(new URL('../../src/features/layout/refresh.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const menu = [...refresh.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => (m[1] ?? '').trim() === '.header-menu > .msg-menu').map((m) => m[2] ?? '').join('\n');
    expect(menu).toMatch(/max-height:/);
    expect(menu).toContain('overflow-y: auto');
  });
});
