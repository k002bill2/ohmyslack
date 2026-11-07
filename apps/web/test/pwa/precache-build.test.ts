import { describe, expect, it } from 'vitest';
import { buildPrecacheEntries } from '../../vite.config.js';

describe('vite swPlugin precache 목록', () => {
  it('해시된 assets와 셸 파일만 넣고 /api·sw.js·소스맵은 넣지 않는다', () => {
    const entries = buildPrecacheEntries(
      {
        'assets/index-Ab12.js': 'js',
        'assets/index-Ab12.js.map': 'map',
        'api/messages': 'x',
        'sw.js': 'sw',
        'index.html': '<html>',
        'precache-manifest.json': '[]',
      },
      { 'manifest.webmanifest': '{}', 'api/x': 'y' },
    );
    expect(entries.map((e) => e.url)).toEqual(['/assets/index-Ab12.js', '/index.html', '/manifest.webmanifest']);
    expect(entries[0]?.revision).toBeNull();
    expect(entries[1]?.revision).toMatch(/^[0-9a-f]{16}$/);
  });
});
