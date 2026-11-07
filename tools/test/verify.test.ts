import { mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSteps, INT_LOG_FILE, runVerify, type VerifyStep } from '../verify.ts';
import { captureCtx } from './helpers.ts';

describe('verify', () => {
  it('follows the DEV_DESIGN 5-1 order', () => {
    const labels = buildSteps({}).map((s) => s.label);
    expect(labels).toEqual([
      'install', 'typecheck', 'lint', 'test', 'test:int', 'build',
      'check:cleanroom', 'check:no-persist-cache', 'check:design-tokens',
      'check:fr-coverage', 'check:log-leak', 'audit',
    ]);
    const intStep = buildSteps({}).find((s) => s.label === 'test:int');
    expect(intStep?.skipReason).toBeUndefined();
    expect(intStep?.logFile).toBe(INT_LOG_FILE);
  });

  it('skips only test:int when VERIFY_SKIP_INT=1 and prints a banner', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'verify-'));
    mkdirSync(join(cwd, 'reports'));
    const ran: VerifyStep[] = [];
    const ctx = captureCtx(cwd, { VERIFY_SKIP_INT: '1' });
    const code = await runVerify(ctx, (step) => {
      ran.push(step);
      return 0;
    });
    expect(code).toBe(0);
    expect(ran.map((s) => s.label)).not.toContain('test:int');
    expect(ran).toHaveLength(11);
    expect(ctx.lines.join('\n')).toContain('SKIPPED (VERIFY_SKIP_INT=1)');
    expect(existsSync(join(cwd, 'reports'))).toBe(false);
  });

  it('stops at the first failing step with exit 1', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'verify-'));
    const ran: string[] = [];
    const ctx = captureCtx(cwd, {});
    const code = await runVerify(ctx, (step) => {
      ran.push(step.label);
      return step.label === 'lint' ? 2 : 0;
    });
    expect(code).toBe(1);
    expect(ran).toEqual(['install', 'typecheck', 'lint']);
    expect(ctx.lines.join('\n')).toContain('VERIFY FAILED at lint (EXIT=2)');
  });
});

describe('spawnExec', () => {
  it('runs pnpm and tees output to the log file when requested', async () => {
    const { spawnExec } = await import('../verify.ts');
    const { readFileSync } = await import('node:fs');
    const cwd = mkdtempSync(join(tmpdir(), 'verify-exec-'));
    expect(spawnExec({ label: 'v', args: ['--version'] }, cwd)).toBe(0);
    expect(spawnExec({ label: 'v', args: ['--version'], logFile: 'reports/int/x.log' }, cwd)).toBe(0);
    expect(readFileSync(join(cwd, 'reports/int/x.log'), 'utf8')).toMatch(/\d+\.\d+\.\d+/);
  });
});
