import { describe, expect, it } from 'vitest';
import { parseFlags } from '../lib/cli.ts';

describe('parseFlags', () => {
  it('parses --k=v, --k v and bare flags', () => {
    expect(parseFlags(['pos', '--mode=gate', '--root', '/tmp/x', '--verbose'])).toEqual({
      mode: 'gate',
      root: '/tmp/x',
      verbose: 'true',
    });
  });

  it('treats a flag followed by another flag as boolean', () => {
    expect(parseFlags(['--a', '--b=1'])).toEqual({ a: 'true', b: '1' });
  });
});

describe('processContext', () => {
  it('binds to the current process', async () => {
    const { processContext } = await import('../lib/cli.ts');
    const ctx = processContext();
    expect(ctx.cwd).toBe(process.cwd());
    expect(ctx.env).toBe(process.env);
  });
});
