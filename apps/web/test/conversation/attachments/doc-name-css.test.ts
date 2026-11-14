// @vitest-environment node
/**
 * QA iPhone r2 W4(B5 관찰): compact 문서 행 파일명 — 확장자부가 이름부 **끝 줄** 뒤에 붙는다(UI_STATES §2-13 말줄임 규칙).
 * 이름부가 2줄로 접히면 flex 기본(stretch·위 정렬)에서는 확장자가 첫 줄 끝에 와 「…_보고.docm / 서_최종…」처럼 읽혔다.
 * jsdom은 CSS를 적용하지 않으므로 규칙 단위로 고정한다. 참고 출처: 일반 관념, 저장소 내부 문서.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../../../src/features/conversation/attachments/attachments.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');

/** `@media (width <= 640px)` 블록 안 텍스트(중괄호 짝 맞춤). 같은 조건 블록이 여럿이면 이어 붙인다. */
function compactBlock(): string {
  const head = '@media (width <= 640px) {';
  let out = '';
  for (let at = css.indexOf(head); at !== -1; at = css.indexOf(head, at + 1)) {
    let depth = 1;
    let i = at + head.length;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
    }
    out += css.slice(at + head.length, i - 1);
  }
  return out;
}

const rule = (text: string, sel: string) =>
  [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => (m[1] ?? '').split(',').some((s) => s.trim() === sel))
    .map((m) => m[2] ?? '')
    .join(';');

describe('W4 compact 문서 파일명: 확장자부는 이름부 끝 줄 뒤', () => {
  const compact = compactBlock();

  it('compact: 파일명 상자가 아래(끝 줄) 정렬 — 확장자가 이름부 마지막 줄 옆에 온다', () => {
    expect(compact).not.toBe('');
    expect(rule(compact, '.doc-name')).toMatch(/align-items: flex-end/);
  });

  it('compact: 이름부 최대 2줄 후 말줄임은 유지', () => {
    const stem = rule(compact, '.doc-name-stem');
    expect(stem).toMatch(/-webkit-line-clamp: 2/);
    expect(stem).toMatch(/white-space: normal/);
  });

  it('확장자부는 줄지 않고 줄바꿈하지 않는다(폭 공통)', () => {
    expect(rule(css, '.doc-name-ext')).toMatch(/flex: none/);
    expect(rule(css, '.doc-name-ext')).toMatch(/white-space: nowrap/);
  });
});
