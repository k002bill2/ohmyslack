// @vitest-environment node
/**
 * CMP-03 SpaceListItem CSS 계약(UI_STATES §2-3, DESIGN_REFERENCE §6-2). jsdom은 계산 스타일을 못 보므로 소스 규칙만 고정한다.
 * 버튼 기본 글꼴(13.33px)·위쪽 붙음 회귀 방지, 읽음/읽지 않음 굵기, 배지·점 정렬, 토큰만 사용(compact·다크 공통).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tokens } from '../../src/ui/tokens.js';

const css = readFileSync(fileURLToPath(new URL('../../src/features/layout/layout.css', import.meta.url)), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** 선택자 목록에 `selector`가 정확히 들어 있는 규칙들의 선언을 합친다. */
function decls(selector: string): string {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? '').split(',').map((s) => s.trim()).includes(selector))
    .map((m) => m[2] ?? '')
    .join(';');
}

describe('사이드바 항목 스타일(CMP-03·CMP-04)', () => {
  it('항목은 상속 글꼴 + --text-md, 가운데 정렬, 좌우 패딩 토큰, 44px 최소 높이', () => {
    const item = decls('.space-item');
    for (const d of [
      'font: inherit',
      'font-size: var(--text-md)',
      'display: flex',
      'align-items: center',
      'padding: 0 var(--space-3)',
      'min-height: 44px',
      'color: var(--text)',
    ]) expect(item).toContain(d);
    expect(item.indexOf('font: inherit')).toBeLessThan(item.indexOf('font-size: var(--text-md)'));
    expect(tokens.typography['--text-md']).toBeDefined();
    expect(tokens.space['--space-3']).toBeDefined();
  });

  it('hover는 --bg-hover, 선택은 hover 중에도 --bg-active와 액센트 선 유지', () => {
    expect(decls('.space-item:hover')).toContain('background: var(--bg-hover)');
    const selectedHover = decls('.space-selected:hover');
    expect(selectedHover).toContain('background: var(--bg-active)');
    expect(selectedHover).toContain('border-left-color: var(--accent-solid)');
  });

  it('읽음 이름은 400, 읽지 않음은 700 — 둘 다 기본 글자색(muted는 나간 채널 전용)', () => {
    expect(decls('.space-name')).toContain('font-weight: 400');
    expect(decls('.space-unread .space-name')).toContain('font-weight: 700');
    expect(decls('.space-name')).not.toContain('color');
    expect(decls('.space-unread .space-name')).not.toContain('color');
    expect(decls('.space-left .space-name')).toContain('color: var(--text-muted)');
  });

  it('멘션 배지는 오른쪽 끝, 새 답글 점과 배지는 줄지 않는다', () => {
    const badge = decls('.unread-badge');
    expect(badge).toContain('margin-left: auto');
    expect(badge).toContain('flex: none');
    expect(decls('.space-item .thread-dot')).toContain('flex: none');
  });

  it('항목·배지 규칙은 색·간격·글자 크기에 토큰만 쓴다(다크·compact 공통)', () => {
    for (const sel of ['.space-item', '.space-item:hover', '.unread-badge', '.space-name']) {
      const body = decls(sel);
      expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
      expect(body).not.toMatch(/(^|;)\s*(font-size|padding|gap)\s*:[^;]*\d+px/);
    }
  });
});
