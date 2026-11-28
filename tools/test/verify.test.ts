import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSteps, cleanArtifacts, INT_LOG_FILE, runVerify, VERIFY_ARTIFACTS, type VerifyStep } from '../verify.ts';
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
    // 로그는 test:int 래퍼가 직접 남긴다(이중 기록·버퍼링 없음).
    expect(intStep?.logFile).toBeUndefined();
    expect(INT_LOG_FILE).toBe('reports/int/test-int.log');
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
    expect(existsSync(join(cwd, 'reports'))).toBe(true);
  });

  it('removes only verify artifacts and keeps reports/qa evidence (2026-11-09 사건 회귀)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'verify-'));
    const put = (rel: string): void => {
      mkdirSync(join(cwd, rel, '..'), { recursive: true });
      writeFileSync(join(cwd, rel), 'x');
    };
    const kept = ['reports/qa/x.png', 'reports/qa/manual/m.json', 'reports/perf/latency.json', 'reports/other.txt'];
    const stale = [
      'reports/vitest-server.json', 'reports/vitest-web.json', 'reports/vitest-shared.json',
      'reports/vitest-tools.json', 'reports/vitest-int.json', 'reports/vitest-perf.json',
      'reports/coverage/server/index.html', 'reports/coverage/web/index.html',
      'reports/coverage/shared/index.html', 'reports/coverage/tools/index.html',
      'reports/int/a.log', INT_LOG_FILE, 'reports/int/sub/b.log',
    ];
    [...kept, ...stale].forEach(put);
    const seen: boolean[] = [];
    const code = await runVerify(captureCtx(cwd, { VERIFY_SKIP_INT: '1' }), () => {
      seen.push(stale.some((rel) => existsSync(join(cwd, rel))));
      return 0;
    });
    expect(code).toBe(0);
    expect(seen[0]).toBe(false);
    for (const rel of kept) expect(existsSync(join(cwd, rel)), rel).toBe(true);
    for (const rel of stale) expect(existsSync(join(cwd, rel)), rel).toBe(false);
  });

  it('fails preflight without deleting a stray top-level reports/*.json', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'verify-'));
    mkdirSync(join(cwd, 'reports/qa'), { recursive: true });
    writeFileSync(join(cwd, 'reports/old-copy.json'), 'null');
    writeFileSync(join(cwd, 'reports/qa/m.json'), '{}');
    const ran: string[] = [];
    const ctx = captureCtx(cwd, {});
    const code = await runVerify(ctx, (step) => {
      ran.push(step.label);
      return 0;
    });
    expect(code).toBe(1);
    expect(ran).toEqual([]);
    expect(ctx.lines.join('\n')).toContain('old-copy.json');
    expect(existsSync(join(cwd, 'reports/old-copy.json'))).toBe(true);
    expect(existsSync(join(cwd, 'reports/qa/m.json'))).toBe(true);
  });

  it('every artifact stays strictly inside reports/ and outside reports/qa', () => {
    for (const rel of VERIFY_ARTIFACTS) {
      expect(rel.startsWith('reports/') && !rel.startsWith('reports/qa')).toBe(true);
      expect(rel.split('/')).not.toContain('..');
    }
  });

  it('refuses artifact paths that escape reports/ or hit protected paths', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'verify-'));
    mkdirSync(join(cwd, 'reports/qa'), { recursive: true });
    writeFileSync(join(cwd, 'reports/qa/x.png'), 'x');
    writeFileSync(join(cwd, 'keep.txt'), 'x');
    for (const bad of ['reports', 'reports/', 'reports/qa', 'reports/qa/x.png', 'reports/../keep.txt', '.', '/tmp']) {
      expect(() => cleanArtifacts(cwd, [bad]), bad).toThrow(/reports\/ 밖이거나 보호 경로/);
    }
    expect(existsSync(join(cwd, 'reports/qa/x.png'))).toBe(true);
    expect(existsSync(join(cwd, 'keep.txt'))).toBe(true);
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
