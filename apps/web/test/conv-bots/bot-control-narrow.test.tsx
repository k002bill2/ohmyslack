// @vitest-environment node
/**
 * QA D-1: 390px에서 채널 헤더 봇 버튼이 2줄로 줄바꿈되고 채널명이 과도하게 잘렸다.
 * jsdom은 레이아웃이 없어 layout.css 소스 규칙과 버튼 title(전체 이름 유지)만 고정한다.
 * (Vitest는 `?raw` CSS를 빈 문자열로 주므로 다른 CSS 계약 테스트처럼 파일을 직접 읽는다.)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BotChannelControl } from '../../src/features/conversation-membership/BotChannelControl.js';
import { BOT_CHANNEL_COPY } from '../../src/ui/copy.js';

const css = readFileSync(fileURLToPath(new URL('../../src/features/layout/layout.css', import.meta.url)), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** 중괄호 짝을 세어 `@media (width <= 640px)` 블록 본문들을 꺼낸다. */
const narrowBlocks = (): string[] => {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf('@media (width <= 640px)', from);
    if (at < 0) return out;
    const open = css.indexOf('{', at);
    let depth = 1;
    let i = open + 1;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
    }
    out.push(css.slice(open + 1, i - 1));
    from = i;
  }
};
/** 같은 선택자 규칙 본문을 모두 이어 붙인다. */
const rules = (source: string, selector: string) =>
  [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? '').trim() === selector)
    .map((m) => m[2] ?? '')
    .join('\n');
const outsideMedia = () => narrowBlocks().reduce((acc, block) => acc.replace(block, ''), css);

describe('봇 컨트롤 좁은 화면(QA D-1)', () => {
  it('컨트롤은 수축하지 않고, 버튼 라벨은 한 줄', () => {
    expect(rules(outsideMedia(), '.bot-channel-control')).toContain('flex: none');
    expect(rules(outsideMedia(), '.bot-channel-control > .btn')).toContain('white-space: nowrap');
    expect(rules(outsideMedia(), '.bot-channel-control > .btn')).toContain('flex: none');
  });

  it('640px 이하에서는 버튼 폭에 상한을 두고 긴 봇 이름을 말줄임한다', () => {
    const narrow = rules(narrowBlocks().join('\n'), '.bot-channel-control > .btn');
    expect(narrow).toMatch(/max-width:/);
    // 봇 배지 QA 관찰 3: 말줄임 규칙은 모든 구간 공통 블록으로 옮겼다(넓은 화면에서도 버튼 하나가 상한보다 길 수 있음).
    const base = rules(outsideMedia(), '.bot-channel-control > .btn');
    expect(base).toContain('overflow: hidden');
    expect(base).toContain('text-overflow: ellipsis');
    expect(base).toContain('align-content: center');
    expect(base).toContain('max-width: 100%');
  });

  it('모든 구간에서 봇이 여럿이거나 이름이 길어도 컨트롤 전체 폭을 헤더 기준으로 제한하고 가로 스크롤한다(Codex r1·r2 P2)', () => {
    const control = rules(outsideMedia(), '.bot-channel-control');
    expect(control).toContain('max-width: 40%');
    expect(control).toContain('overflow-x: auto');
  });

  it('봇 배지 QA 관찰 3: 640px 초과(1440 스레드 열림 등)에서는 버튼이 잘리지 않고 다음 줄로 넘어간다(flex-wrap), 640px 이하는 기존 한 줄', () => {
    const control = rules(outsideMedia(), '.bot-channel-control');
    expect(control).toContain('flex-wrap: wrap');
    expect(control).toContain('justify-content: flex-end');
    const narrow = rules(narrowBlocks().join('\n'), '.bot-channel-control');
    expect(narrow).toContain('flex-wrap: nowrap');
    // 가로 스크롤 컨테이너는 시작 쪽 넘침에 닿지 못한다 — 좁은 화면은 flex-start로 되돌린다.
    expect(narrow).toContain('justify-content: flex-start');
  });

  it('봇 배지 QA 관찰 3: 버튼은 접히지 않고 DOM·탭 순서에 모두 남는다', () => {
    const ok = async () => ({ ok: true as const, value: null });
    const html = renderToStaticMarkup(
      <BotChannelControl
        bots={[
          { id: 'b1', displayName: 'QA 알림 봇 아주 긴 이름 하나' },
          { id: 'b2', displayName: 'QA 알림 봇 아주 긴 이름 둘' },
        ]}
        memberIds={new Set(['b1', 'b2'])}
        onAdd={ok}
        onRemove={ok}
      />,
    );
    const buttons = [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)];
    expect(buttons.map((b) => b[2])).toEqual([BOT_CHANNEL_COPY.title('QA 알림 봇 아주 긴 이름 하나'), BOT_CHANNEL_COPY.title('QA 알림 봇 아주 긴 이름 둘')]);
    for (const b of buttons) expect(b[1]).not.toMatch(/tabindex|hidden|aria-hidden|disabled/i);
  });

  it('버튼 title이 전체 라벨을 유지하고 라벨(접근 이름) 문구는 그대로', () => {
    const ok = async () => ({ ok: true as const, value: null });
    const html = renderToStaticMarkup(
      <BotChannelControl
        bots={[
          { id: 'b1', displayName: 'QA 봇 아주 긴 이름' },
          { id: 'b2', displayName: 'Jarvis' },
        ]}
        memberIds={new Set(['b1'])}
        onAdd={ok}
        onRemove={ok}
      />,
    );
    const remove = BOT_CHANNEL_COPY.title('QA 봇 아주 긴 이름');
    const add = BOT_CHANNEL_COPY.add('Jarvis');
    expect(html).toContain(`title="${remove}"`);
    expect(html).toContain(`>${remove}</button>`);
    expect(html).toContain(`title="${add}"`);
    expect(html).toContain(`>${add}</button>`);
  });
});
