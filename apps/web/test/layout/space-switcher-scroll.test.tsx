/** 공간 전환기 활성 후보 스크롤은 활성 후보·검색어가 바뀔 때만(배경 재렌더로 스크롤이 되돌아가지 않게, Codex F-1 r2 P2). */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Space } from '../../src/data';
import { SpaceSwitcher } from '../../src/features/layout/SpaceSwitcher.js';

afterEach(cleanup);

const spaces: readonly Space[] = [
  { id: 'a', kind: 'channel', name: 'alpha', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 },
  { id: 'b', kind: 'channel', name: 'beta', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 },
];
const titleOf = (s: Space) => `#${s.name}`;

describe('SpaceSwitcher 스크롤', () => {
  it('같은 활성 후보로 다시 렌더되면(배경 갱신) 스크롤하지 않는다', () => {
    let calls = 0;
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = () => {
      calls += 1;
    };
    try {
      const view = render(<SpaceSwitcher spaces={spaces} titleOf={titleOf} onSelect={() => undefined} onClose={() => undefined} />);
      const first = calls;
      view.rerender(
        <SpaceSwitcher spaces={[...spaces.map((s) => ({ ...s, unreadCount: 1 }))]} titleOf={titleOf} onSelect={() => undefined} onClose={() => undefined} />,
      );
      expect(calls).toBe(first);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
