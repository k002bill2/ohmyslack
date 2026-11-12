// @vitest-environment node
/** dialog-busy-focus 항목 2: 390 긴 채널명에서 머리 「다시 참여」가 한 글자씩 세로로 접히지 않는다 — 버튼은 nowrap·shrink 0, 이름이 말줄임(jsdom은 CSS 미적용 — 규칙으로 본다). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../../src/features/layout/layout.css', import.meta.url)), 'utf8').replace(/\s+/g, ' ');

describe('머리 텍스트 버튼 CSS', () => {
  it('.conversation-header > .btn: flex none + white-space nowrap', () => {
    expect(css).toMatch(/\.conversation-header > \.btn \{ flex: none; white-space: nowrap; \}/);
  });
  it('줄어드는 쪽은 대화 이름: heading min-width 0, title ellipsis', () => {
    expect(css).toMatch(/\.conversation-heading \{ flex: 1 1 auto; min-width: 0;/);
    expect(css).toMatch(/\.conversation-title \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis; white-space: nowrap;/);
  });
});
