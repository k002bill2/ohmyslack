import { describe, expect, it } from 'vitest';
import { checkTestDbUrl, run } from '../assert-test-db.ts';
import { captureCtx } from './helpers.ts';

describe('assert-test-db', () => {
  it.each([
    'postgres://u:p@127.0.0.1:5432/ohmyslack_test',
    'postgresql://u@localhost/app_test',
  ])('accepts a local *_test database: %s', async (url) => {
    expect(checkTestDbUrl(url).ok).toBe(true);
    const ctx = captureCtx('.', { TEST_DATABASE_URL: url });
    expect(await run([], ctx)).toBe(0);
    expect(ctx.lines.join('\n')).not.toContain(':p@');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['unparseable', 'not a url'],
    ['wrong scheme', 'mysql://u@127.0.0.1/x_test'],
    ['production db name', 'postgres://u@127.0.0.1:5432/ohmyslack'],
    ['remote host', 'postgres://u@db.example.com:5432/ohmyslack_test'],
    ['remote host and prod name', 'postgres://u@db.example.com:5432/ohmyslack'],
    ['suffix only in query', 'postgres://u@127.0.0.1/ohmyslack?x=_test'],
    ['missing db name', 'postgres://u@127.0.0.1:5432/'],
  ])('rejects %s', async (_label, url) => {
    expect(checkTestDbUrl(url).ok).toBe(false);
    const ctx = captureCtx('.', { TEST_DATABASE_URL: url });
    expect(await run([], ctx)).toBe(1);
  });

  it('never echoes the password', async () => {
    const ctx = captureCtx('.', { TEST_DATABASE_URL: 'postgres://u:supersecret@db.example.com/x' });
    expect(await run([], ctx)).toBe(1);
    expect(ctx.lines.join('\n')).not.toContain('supersecret');
  });
});
