// @vitest-environment node
/** QA r2 D1: 작성기 문서 칩 — 확장자부는 줄지 않고, 「첨부 제거」는 글자 단위로 세로 줄바꿈되지 않는다(jsdom은 CSS 미적용 — 규칙으로 본다). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../../../src/features/conversation/attachments/attachments.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');

/** 선택자 목록에 `sel`이 독립 항목으로 들어 있는 규칙 본문(미디어 쿼리 밖·안 모두). */
const rule = (sel: string) =>
  [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => (m[1] ?? '').split(',').some((s) => s.trim() === sel))
    .map((m) => m[2] ?? '')
    .join(';');

describe('QA r2 D1 작성기 문서 칩 CSS', () => {
  it('파일명 상자: flex + min-width 0(이름부만 줄어든다)', () => {
    expect(rule('.composer-chip-name')).toMatch(/display: flex/);
    expect(rule('.composer-chip-name')).toMatch(/min-width: 0/);
  });
  it('이름부: 한 줄 말줄임', () => {
    const body = rule('.composer-chip-name-stem');
    expect(body).toMatch(/min-width: 0/);
    expect(body).toMatch(/overflow: hidden/);
    expect(body).toMatch(/text-overflow: ellipsis/);
    expect(body).toMatch(/white-space: nowrap/);
  });
  it('확장자부: 줄지 않음(flex none + nowrap)', () => {
    expect(rule('.composer-chip-name-ext')).toMatch(/flex: none/);
    expect(rule('.composer-chip-name-ext')).toMatch(/white-space: nowrap/);
  });
  it('「첨부 제거」·크기·업로드 중 표시: 줄지 않고 줄바꿈하지 않음', () => {
    for (const sel of ['.composer-chip .msg-action', '.composer-chip-size', '.composer-chip-state']) {
      expect(rule(sel), sel).toMatch(/flex: none/);
      expect(rule(sel), sel).toMatch(/white-space: nowrap/);
    }
  });
});

describe('작성기 칩 이미지 썸네일 CSS(D §6-5)', () => {
  it('정사각 2.5rem·cover·--radius-sm·1px --border-subtle·바탕 --bg-elevated, 줄지 않음', () => {
    const body = rule('.composer-chip-thumb');
    expect(body).toMatch(/width: 2\.5rem/);
    expect(body).toMatch(/height: 2\.5rem/);
    expect(body).toMatch(/object-fit: cover/);
    expect(body).toMatch(/border-radius: var\(--radius-sm\)/);
    expect(body).toMatch(/border: 1px solid var\(--border-subtle\)/);
    expect(body).toMatch(/background: var\(--bg-elevated\)/);
    expect(body).toMatch(/flex: none/);
    expect(body).not.toMatch(/px;?\s*(height|width)/);
  });
});
