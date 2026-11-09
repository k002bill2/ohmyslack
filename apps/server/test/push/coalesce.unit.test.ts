import { describe, expect, it } from 'vitest';
import { PUSH_COALESCE_WINDOW_MS } from '../../src/shared.js';
import { pruneCoalesce } from '../../src/modules/push/service.js';

/** W-23b: 알림 묶음 맵은 창(60초)이 지난 항목을 지운다 — 창 안 항목은 유지(묶음 판정 불변). */
describe('push 묶음 맵 만료 정리', () => {
  it('창이 지난 항목만 지우고 창 안 항목은 남긴다', () => {
    const now = 1_000_000;
    const map = new Map<string, number>([
      ['old', now - PUSH_COALESCE_WINDOW_MS],
      ['older', now - PUSH_COALESCE_WINDOW_MS - 1],
      ['fresh', now - PUSH_COALESCE_WINDOW_MS + 1],
      ['now', now],
    ]);
    pruneCoalesce(map, now);
    expect([...map.keys()].sort()).toEqual(['fresh', 'now']);
  });
});
