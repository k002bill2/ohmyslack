/**
 * 스레드 답글 작성기 도크(composer-dock): 작성기·잠금 안내를 불투명 래퍼 [data-composer="thread"]에 담아
 * 패널 스크롤로 지나가는 답글이 작성기 둘레로 비치지 않게 한다 — 래퍼는 .thread-panel의 마지막 자식(sticky 하단).
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ThreadPanel, type ThreadVariant } from '../../src/features/thread/index.js';
import type { MessageItemData } from '../../src/features/conversation/index.js';
import { T0 } from '../helpers/fixtures.js';

afterEach(cleanup);

const msg = (id: string): MessageItemData => ({ id, author: '홍길동', createdAt: T0, body: `본문 ${id}` });

function panel(variant: ThreadVariant, composerNotice?: string) {
  return (
    <ThreadPanel
      variant={variant}
      root={msg('m1')}
      replies={[msg('r1'), msg('r2')]}
      onClose={() => {}}
      onSend={() => {}}
      announce={() => {}}
      {...(composerNotice === undefined ? {} : { composerNotice })}
    />
  );
}

const dock = () => {
  const p = document.querySelector<HTMLElement>('.thread-panel');
  if (p === null) throw new Error('스레드 패널 없음');
  const d = p.querySelector<HTMLElement>(':scope > [data-composer="thread"]');
  return { p, d };
};

describe('스레드 답글 작성기 도크', () => {
  it.each<ThreadVariant>(['wide', 'medium', 'compact'])('%s: 작성기 입력란이 패널 마지막 자식 래퍼 안에 있다', (variant) => {
    render(panel(variant));
    const { p, d } = dock();
    expect(d).not.toBeNull();
    expect(p.lastElementChild).toBe(d);
    expect(d?.querySelector(':scope > .composer textarea')).not.toBeNull();
    expect(p.querySelector(':scope > .composer')).toBeNull();
  });

  it.each<ThreadVariant>(['wide', 'medium', 'compact'])('%s: 잠금 안내도 같은 래퍼 안에 있다', (variant) => {
    render(panel(variant, '비활성 상대'));
    const { p, d } = dock();
    expect(p.lastElementChild).toBe(d);
    expect(d?.querySelector(':scope > .composer-notice')?.textContent).toBe('비활성 상대');
    expect(p.querySelector(':scope > .composer-notice')).toBeNull();
    expect(p.querySelector('textarea')).toBeNull();
  });
});
