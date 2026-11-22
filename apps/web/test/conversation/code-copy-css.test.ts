// @vitest-environment node
/**
 * 코드 블록 「복사」 버튼 노출 규칙: 마우스(hover: hover)는 hover·focus-within일 때만 보이고, 터치(hover: none)는 항상 보인다.
 * 투명 상태에서도 포커스 가능해야 해서 display:none·visibility:hidden을 쓰지 않는다. 래퍼는 390px 넘침 0 규칙을 따른다.
 * jsdom은 레이아웃·미디어쿼리가 없어 소스 규칙만 고정한다(message-body-overflow-css.test.ts와 같은 방식).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../../src/features/conversation/conversation.css', import.meta.url)), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** `@media (...) { ... }` 블록 본문(중첩 1단계). */
function mediaBody(query: string): string {
  const start = css.indexOf(`@media ${query}`);
  if (start < 0) return '';
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(css.indexOf('{', start) + 1, i);
    }
  }
  return '';
}
const ruleBody = (src: string, selector: string) =>
  [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? '').split(',').map((s) => s.trim()).includes(selector))
    .map((m) => m[2] ?? '')
    .join('\n');

describe('코드 블록 복사 버튼 CSS', () => {
  it('hover 환경은 숨김(opacity 0) → hover·focus-within에서 보임, 터치는 항상 보임, display/visibility로 숨기지 않음', () => {
    const hover = mediaBody('(hover: hover)');
    expect(ruleBody(hover, '.msg-code-block .msg-code-copy')).toContain('opacity: 0');
    expect(ruleBody(hover, '.msg-code-block:hover .msg-code-copy')).toContain('opacity: 1');
    expect(ruleBody(hover, '.msg-code-block:focus-within .msg-code-copy')).toContain('opacity: 1');
    expect(ruleBody(mediaBody('(hover: none)'), '.msg-code-block .msg-code-copy')).toContain('opacity: 1');
    const all = `${ruleBody(css, '.msg-code-copy')}\n${hover}`;
    expect(all).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });

  it('래퍼는 부모 폭을 넘지 않고(max-width 100%, min-width 0) 버튼 기준점(position: relative)이다', () => {
    const wrap = ruleBody(css, '.msg-code-block');
    expect(wrap).toContain('position: relative');
    expect(wrap).toContain('max-width: 100%');
    expect(wrap).toContain('min-width: 0');
    expect(ruleBody(css, '.msg-code-copy')).toContain('position: absolute');
  });
  it('아이콘 버튼은 정사각(폭·높이 = --code-copy-w = 1.75rem=28px), 글자용 min-width·white-space 없음, 아이콘 가운데', () => {
    expect(ruleBody(css, '.msg-code-block')).toContain('--code-copy-w: 1.75rem');
    const btn = ruleBody(css, '.msg-code-copy');
    expect(btn).toContain('width: var(--code-copy-w)');
    expect(btn).toContain('height: var(--code-copy-w)');
    expect(btn).toContain('box-sizing: border-box');
    expect(btn).not.toMatch(/min-width|white-space|font-size/);
    expect(btn).toContain('display: inline-flex');
    expect(btn).toContain('align-items: center');
    expect(btn).toContain('justify-content: center');
    expect(btn).toContain('padding: 0');
    expect(btn).toContain('background: var(--bg-elevated)');
    expect(btn).toContain('border: 1px solid var(--border-subtle)');
    expect(btn).toContain('border-radius: var(--radius-md)');
  });

  it('P2-1: pre 오른쪽 여백 = --code-copy-w + 간격 2배 — 버튼(오른쪽 --space-2 안쪽)과 끝 글자 사이 ≥ --space-2 − 1px(pre 테두리)', () => {
    // 래퍼 오른쪽 끝 기준: 버튼은 8px~36px, pre 내용 끝은 28 + 16 = 44px(테두리 1px 포함) → 간격 44 − 36 − 1 = 7px = --space-2 − 1px.
    expect(ruleBody(css, '.msg-code-block .msg-code')).toContain('padding-inline-end: calc(var(--code-copy-w) + var(--space-2) * 2)');
  });

  it('P3: .msg-code-block .msg-code 규칙이 .msg-body .msg-code보다 뒤에 온다(같은 명시도에서 padding이 이김)', () => {
    const base = css.search(/(^|\})\s*\.msg-body \.msg-code\s*\{/);
    const block = css.search(/(^|\})\s*\.msg-code-block \.msg-code\s*\{/);
    expect(base).toBeGreaterThanOrEqual(0);
    expect(block).toBeGreaterThan(base);
  });

  it('실패 아이콘(x)만 --danger-text 색, 나머지는 버튼 글자색(currentColor)', () => {
    expect(ruleBody(css, '.msg-code-copy')).toContain('color: var(--text)');
    expect(ruleBody(css, '.msg-code-copy[data-state="failed"]')).toContain('color: var(--danger-text)');
  });

  it('버튼·안내 글자는 드래그 선택에 섞이지 않는다(user-select: none)', () => {
    for (const sel of ['.msg-code-copy', '.msg-code-note']) {
      expect(ruleBody(css, sel)).toContain('user-select: none');
      expect(ruleBody(css, sel)).toContain('-webkit-user-select: none');
    }
  });

  it('터치(hover: none)만 투명 ::after로 히트 영역 ≥ 44×44px 확장 — 위·오른쪽은 래퍼 안쪽 여백(--space-2)까지만', () => {
    // 가로 = 왼쪽 8 + 버튼 28 + 오른쪽 8 = 44px, 세로 = 위 8 + 28 + 아래 16(--space-4) = 52px (1rem = 16px).
    const after = ruleBody(mediaBody('(hover: none)'), '.msg-code-block .msg-code-copy::after');
    expect(after).toContain("content: ''");
    expect(after).toContain('position: absolute');
    expect(after).toContain('inset-block-start: calc(var(--space-2) * -1)');
    expect(after).toContain('inset-inline-end: calc(var(--space-2) * -1)');
    expect(after).toContain('inset-inline-start: calc(var(--space-2) * -1)');
    expect(after).toContain('inset-block-end: calc(var(--space-4) * -1)');
    expect(ruleBody(css, '.msg-code-copy::after')).toBe('');
  });

  it('안내(.msg-code-note)는 보조기술 전용 — 레이아웃을 밀지 않는다(display: block 없음, absolute)', () => {
    const note = ruleBody(css, '.msg-code-note');
    expect(note).not.toMatch(/display:\s*block/);
    expect(note).toContain('position: absolute');
    expect(note).toContain('clip-path: inset(50%)');
  });
});
