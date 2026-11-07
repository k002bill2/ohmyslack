import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCleanroomSpec, run } from '../check-cleanroom.ts';
import { captureCtx } from './helpers.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const CLEANROOM = join(REPO, 'CLEANROOM.md');

/** 금지 문자열은 소스에 적지 않고 정본 패턴의 첫 대안에서 런타임에 만든다. */
function forbiddenToken(): string {
  const spec = parseCleanroomSpec(readFileSync(CLEANROOM, 'utf8'));
  const first = spec.pattern.split('|')[0] ?? '';
  return first.replace(/\\/g, '');
}

function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cleanroom-'));
  copyFileSync(CLEANROOM, join(root, 'CLEANROOM.md'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('check-cleanroom', () => {
  it('parses pattern and excludes from CLEANROOM.md section 5', () => {
    const spec = parseCleanroomSpec(readFileSync(CLEANROOM, 'utf8'));
    expect(spec.pattern.split('|').length).toBeGreaterThan(3);
    expect(spec.excludeDirs).toEqual(expect.arrayContaining(['node_modules', '.git', '00-research']));
    expect(spec.excludeFiles).toContain('CLEANROOM.md');
    expect(spec.flags).toBe('-rIinE');
  });

  it('passes (0) on a clean tree', async () => {
    const root = fixtureRoot({ 'src/a.ts': 'export const ok = 1;\n' });
    const ctx = captureCtx(root, {});
    expect(await run([], ctx)).toBe(0);
    expect(ctx.lines.join('\n')).toContain('CLEANROOM OK');
  });

  it('fails (1) on a violation, but ignores excluded dirs', async () => {
    const token = forbiddenToken();
    const root = fixtureRoot({ 'src/bad.ts': `// ${token.toUpperCase()}\n`, 'node_modules/x/y.js': token });
    const ctx = captureCtx(root, {});
    expect(await run([], ctx)).toBe(1);
    const text = ctx.lines.join('\n');
    expect(text).toContain('src/bad.ts');
    expect(text).not.toContain('node_modules');
  });

  it('passes when the violation sits only in an excluded dir', async () => {
    const root = fixtureRoot({ 'docs/00-research/n.md': forbiddenToken() });
    expect(await run([], captureCtx(root, {}))).toBe(0);
  });

  it('fails (1) when the target root does not exist', async () => {
    const ctx = captureCtx('/nonexistent-cleanroom-root', {});
    expect(await run(['--cleanroom', CLEANROOM], ctx)).toBe(1);
  });

  it('fails (1) when CLEANROOM.md is missing or section 5 block is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanroom-'));
    expect(await run([], captureCtx(root, {}))).toBe(1);
    writeFileSync(join(root, 'CLEANROOM.md'), '# x\n\n## 5. 기계 검증\n\n텍스트만\n');
    const ctx = captureCtx(root, {});
    expect(await run([], ctx)).toBe(1);
    expect(ctx.lines.join('\n')).toContain('5절');
  });

  it.skipIf(process.getuid?.() === 0)('fails (1) on an unreadable file', async () => {
    const root = fixtureRoot({ 'src/locked.ts': 'export {};\n' });
    chmodSync(join(root, 'src/locked.ts'), 0o000);
    try {
      expect(await run([], captureCtx(root, {}))).toBe(1);
    } finally {
      chmodSync(join(root, 'src/locked.ts'), 0o644);
    }
  });

  it('passes on the real repository', async () => {
    expect(await run([], captureCtx(REPO, {}))).toBe(0);
  });
});
