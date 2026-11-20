// @vitest-environment node
/**
 * 메시지 본문 가로 넘침 방지(모바일 390px): `.msg-item`은 flex-wrap 컨테이너이고 `.msg-body`는 flex item이라
 * `min-width: auto`면 자식 `pre.msg-code`(white-space: pre)의 min-content까지 늘어난다 → 목록에 좌우 스크롤.
 * jsdom은 레이아웃이 없어 소스 규칙만 고정한다(composer-focus-css.test.ts와 같은 방식).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../../src/features/conversation/conversation.css', import.meta.url)), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] ?? '').trim(), body: m[2] ?? '' }));
const bodyOf = (match: (selector: string) => boolean) =>
  rules
    .filter((r) => match(r.selector))
    .map((r) => r.body)
    .join('\n');

describe('메시지 본문 가로 넘침', () => {
  it('.msg-item > .msg-body 를 포함하는 flex item 규칙이 min-width: 0 을 둔다', () => {
    const rule = bodyOf((s) => s.includes('.msg-item > .msg-body'));
    expect(rule).toContain('min-width: 0');
  });

  it('형제 flex item(.msg-deleted·.msg-editor·.msg-status)도 같은 규칙에서 막는다', () => {
    const hit = rules.find((r) => r.selector.includes('.msg-item > .msg-body'));
    expect(hit?.selector).toContain('.msg-item > .msg-deleted');
    expect(hit?.selector).toContain('.msg-item > .msg-editor');
    expect(hit?.selector).toContain('.msg-item > .msg-status');
  });

  it('.msg-body .msg-code 는 부모 폭을 넘지 않는다(max-width: 100%)', () => {
    expect(bodyOf((s) => s === '.msg-body .msg-code')).toContain('max-width: 100%');
  });

  it('.msg-code 는 overflow-x: auto 를 유지해 긴 줄은 블록 안에서만 스크롤한다', () => {
    expect(bodyOf((s) => s === '.msg-code')).toContain('overflow-x: auto');
  });
});
