/**
 * header-390: 390 채널 머리 봇 컨트롤은 한 줄 가로 스크롤이라 Tab·Shift+Tab으로 간 버튼이 보이는 영역 밖에 걸칠 수 있었다.
 * jsdom은 레이아웃이 없으므로 포커스된 봇 버튼마다 가장 가까운 위치로 `scrollIntoView`를 부르는지(행동 단위)만 고정한다.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotChannelControl } from '../../src/features/conversation-membership/BotChannelControl.js';
import { BOT_CHANNEL_COPY } from '../../src/ui/copy.js';

const ok = async () => ({ ok: true as const, value: null });
const scrolls: { readonly label: string | null; readonly options: unknown }[] = [];
const original = Element.prototype.scrollIntoView;

beforeEach(() => {
  scrolls.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element, options?: unknown) {
    scrolls.push({ label: this.textContent, options });
  });
});
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = original;
});

function renderControl() {
  render(
    <>
      <button type="button">앞</button>
      <BotChannelControl
        bots={[
          { id: 'b1', displayName: 'QA 봇' },
          { id: 'b2', displayName: '가나다라마바사아자차카타파하 알림 전달 봇' },
        ]}
        memberIds={new Set(['b1'])}
        onAdd={ok}
        onRemove={ok}
      />
      <button type="button">뒤</button>
    </>,
  );
}

describe('header-390 봇 컨트롤 포커스 스크롤', () => {
  const first = BOT_CHANNEL_COPY.title('QA 봇');
  const second = BOT_CHANNEL_COPY.add('가나다라마바사아자차카타파하 알림 전달 봇');
  const nearest = { block: 'nearest', inline: 'nearest' };

  it('Tab으로 각 봇 버튼에 가면 그 버튼을 컨트롤의 보이는 영역으로 끌어온다', async () => {
    const user = userEvent.setup();
    renderControl();
    screen.getByRole('button', { name: '앞' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: first }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: second }));
    expect(scrolls).toEqual([
      { label: first, options: nearest },
      { label: second, options: nearest },
    ]);
  });

  it('Shift+Tab 역방향도 같다', async () => {
    const user = userEvent.setup();
    renderControl();
    screen.getByRole('button', { name: '뒤' }).focus();
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: first }));
    expect(scrolls).toEqual([
      { label: second, options: nearest },
      { label: first, options: nearest },
    ]);
  });

  it('컨트롤 밖 버튼 포커스에는 스크롤하지 않는다', async () => {
    const user = userEvent.setup();
    renderControl();
    screen.getByRole('button', { name: '앞' }).focus();
    await user.tab({ shift: true });
    expect(scrolls).toEqual([]);
  });
});
