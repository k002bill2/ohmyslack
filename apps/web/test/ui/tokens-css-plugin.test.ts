// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TOKENS_CSS_ID, tokensCssPlugin } from '../../vite.config.js';
import { buildTokensCss } from '../../src/ui/tokens.css.js';

type Hook = (id: string) => unknown;

describe('토큰 CSS 연결(빌드 시 정적 CSS 파일, 런타임 <style> 주입 없음)', () => {
  it('가상 모듈 id를 해석하고 buildTokensCss() 결과를 CSS 모듈로 제공한다', () => {
    const plugin = tokensCssPlugin();
    const resolveId = plugin.resolveId as unknown as Hook;
    const load = plugin.load as unknown as Hook;
    expect(TOKENS_CSS_ID.endsWith('.css')).toBe(true);
    expect(resolveId(TOKENS_CSS_ID)).toBe(TOKENS_CSS_ID);
    expect(resolveId('other')).toBeUndefined();
    expect(load(TOKENS_CSS_ID)).toBe(buildTokensCss());
    expect(load('other')).toBeUndefined();
  });

  it('main.tsx가 가상 CSS 모듈을 import하고 style 요소를 직접 만들지 않는다', () => {
    const main = readFileSync(new URL('../../src/main.tsx', import.meta.url), 'utf8');
    expect(main).toContain(`import '${TOKENS_CSS_ID}';`);
    expect(main).not.toMatch(/createElement\(['"]style|<style|innerHTML/);
  });
});
