import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOG_CANARIES } from '../log-canaries.ts';
import { run } from '../check-log-leak.ts';
import { captureCtx } from './helpers.ts';

function reportsRoot(logs: Record<string, string> | null): string {
  const root = mkdtempSync(join(tmpdir(), 'logleak-'));
  mkdirSync(join(root, 'reports'));
  if (logs !== null) {
    for (const [rel, body] of Object.entries(logs)) {
      mkdirSync(join(root, 'reports/int', rel, '..'), { recursive: true });
      writeFileSync(join(root, 'reports/int', rel), body);
    }
  }
  return root;
}

describe('check-log-leak', () => {
  it('defines distinct canaries for body, credential and token', () => {
    const values = Object.values(LOG_CANARIES);
    expect(new Set(values).size).toBe(values.length);
    expect(Object.keys(LOG_CANARIES)).toEqual(expect.arrayContaining(['body', 'credential', 'token']));
  });

  it('passes (0) with 검사 대상 없음 when there are no int logs', async () => {
    const ctx = captureCtx(reportsRoot(null), {});
    expect(await run([], ctx)).toBe(0);
    expect(ctx.lines.join('\n')).toContain('검사 대상 없음');
  });

  it('passes (0) on clean logs', async () => {
    const root = reportsRoot({ 'test-int.log': 'GET /api/healthz 200\n', 'sub/ws.log': 'ws open\n' });
    expect(await run([], captureCtx(root, {}))).toBe(0);
  });

  it.each(Object.entries(LOG_CANARIES))('fails (1) when the %s canary leaks', async (_k, canary) => {
    const root = reportsRoot({ 'sub/ws.log': `msg body=${canary}\n` });
    const ctx = captureCtx(root, {});
    expect(await run([], ctx)).toBe(1);
    expect(ctx.lines.join('\n')).toContain('sub/ws.log:1');
  });

  it('fails (1) when reports/ itself is missing (test step did not run)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'logleak-'));
    expect(await run([], captureCtx(root, {}))).toBe(1);
  });

  it.skipIf(process.getuid?.() === 0)('fails (1) on an unreadable log', async () => {
    const root = reportsRoot({ 'a.log': 'x' });
    chmodSync(join(root, 'reports/int/a.log'), 0o000);
    try {
      expect(await run([], captureCtx(root, {}))).toBe(1);
    } finally {
      chmodSync(join(root, 'reports/int/a.log'), 0o644);
    }
  });

  it('prints a SKIPPED banner and passes when VERIFY_SKIP_INT=1', async () => {
    const root = mkdtempSync(join(tmpdir(), 'logleak-'));
    const ctx = captureCtx(root, { VERIFY_SKIP_INT: '1' });
    expect(await run([], ctx)).toBe(0);
    expect(ctx.lines.join('\n')).toContain('SKIPPED (VERIFY_SKIP_INT=1)');
  });
});
