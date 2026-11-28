import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOG_CANARIES } from '../log-canaries.ts';
import { run } from '../check-log-leak.ts';
import { captureCtx } from './helpers.ts';

/** reports/int 아래 로그를 만든다. test:int 래퍼 로그(test-int.log)는 따로 주지 않으면 깨끗한 내용으로 둔다. */
function reportsRoot(logs: Record<string, string> | null, withIntLog = true, withResult = true): string {
  const root = mkdtempSync(join(tmpdir(), 'logleak-'));
  mkdirSync(join(root, 'reports'));
  if (withResult) writeFileSync(join(root, 'reports/vitest-int.json'), '{}'); // 로그보다 먼저 써서 로그가 더 새롭다
  const all = withIntLog ? { 'test-int.log': 'GET /api/healthz 200\n[test:int] exit=0\n', ...logs } : logs;
  if (all !== null) {
    for (const [rel, body] of Object.entries(all)) {
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

  it('includes the bot token and push endpoint canaries (FR-OPS-03 R3.3)', () => {
    expect(Object.keys(LOG_CANARIES)).toEqual(expect.arrayContaining(['bot', 'push_endpoint']));
    // 호스트만 로그에 남기는 규칙(TRD §6-2)이므로 카나리아는 endpoint 경로 쪽에 둔다 — 호스트 문자열이 섞이면 정상 로그가 오탐된다.
    expect(LOG_CANARIES.push_endpoint).not.toMatch(/push\.apple\.com|googleapis|mozilla/);
  });

  it('includes the attachment filename canary (W-26, TRD §6-1-1)', () => {
    expect(Object.keys(LOG_CANARIES)).toEqual(expect.arrayContaining(['filename']));
  });

  it('fails (1) when an attachment filename leaks into a log line', async () => {
    const root = reportsRoot({ 'att.log': `{"event":"probe","x-attachment-filename":"${LOG_CANARIES.filename}.docx"}\n` });
    const ctx = captureCtx(root, {});
    expect(await run([], ctx)).toBe(1);
    expect(ctx.lines.join('\n')).toContain('filename 카나리아');
  });

  it('fails (1) when a full push endpoint URL leaks into a log line', async () => {
    const root = reportsRoot({ 'push.log': `{"event":"push_send_result","endpoint":"https://web.push.apple.com/${LOG_CANARIES.push_endpoint}"}\n` });
    const ctx = captureCtx(root, {});
    expect(await run([], ctx)).toBe(1);
    expect(ctx.lines.join('\n')).toContain('push_endpoint 카나리아');
  });

  it('fails (1) when the test:int log is missing instead of passing vacuously', async () => {
    const ctx = captureCtx(reportsRoot(null, false), {});
    expect(await run([], ctx)).toBe(1);
    expect(ctx.lines.join('\n')).toContain('reports/int/test-int.log 가 없습니다');
  });

  it('fails (1) when the int result file is missing (freshness undeterminable)', async () => {
    const ctx = captureCtx(reportsRoot(null, true, false), {});
    expect(await run([], ctx)).toBe(1);
    expect(ctx.lines.join('\n')).toContain('로그 신선도를 판정할 수 없습니다');
  });

  it('fails (1) when only other logs exist (test:int wrapper log missing)', async () => {
    const ctx = captureCtx(reportsRoot({ 'sub/ws.log': 'ws open\n' }, false), {});
    expect(await run([], ctx)).toBe(1);
  });

  it('fails (1) when the int log is older than the last int run result (stale log)', async () => {
    const root = reportsRoot(null);
    writeFileSync(join(root, 'reports/vitest-int.json'), '{}');
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(root, 'reports/int/test-int.log'), old, old);
    const ctx = captureCtx(root, {});
    expect(await run([], ctx)).toBe(1);
    expect(ctx.lines.join('\n')).toContain('보다 오래됐습니다');
  });

  it('passes (0) when the int log is newer than the int run result', async () => {
    const root = reportsRoot(null);
    writeFileSync(join(root, 'reports/vitest-int.json'), '{}');
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(root, 'reports/vitest-int.json'), old, old);
    const ctx = captureCtx(root, {});
    expect(await run([], ctx)).toBe(0);
    expect(ctx.lines.join('\n')).toContain('로그 1개');
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
