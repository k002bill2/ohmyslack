import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { App } from '../src/App.js';

describe('App', () => {
  it('matchMedia 없는 SSR에서도 메모리 DataSource로 AppShell(wide 폴백)을 렌더한다', () => {
    const html = renderToString(<App />);
    expect(html).toContain('data-layout="wide"');
    expect(html).toContain('aria-label="공간"');
  });
});
