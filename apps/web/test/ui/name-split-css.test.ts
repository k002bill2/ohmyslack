// @vitest-environment node
/** QA D2·D3: 비활성 이름 접미는 줄지 않는 한 덩어리(nowrap), 말줄임 자리(.name-split)는 이름 span만 줄인다(jsdom은 CSS 미적용 — 규칙으로 본다). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../../src/ui/base.css', import.meta.url)), 'utf8').replace(/\s+/g, ' ');

describe('QA D2·D3 — 비활성 이름 CSS', () => {
  it('접미 span: flex none + white-space nowrap', () => {
    expect(css).toMatch(/\.name-suffix \{ flex: none; white-space: nowrap; \}/);
  });
  it('말줄임 컨테이너: flex + min-width 0, 이름 span만 ellipsis', () => {
    expect(css).toMatch(/\.name-split \{ display: flex;[^}]*gap: var\(--space-1\);[^}]*min-width: 0; \}/);
    expect(css).toMatch(/\.name-split \.name-base \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  });
});
