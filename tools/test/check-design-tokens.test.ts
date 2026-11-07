import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from '../check-design-tokens.ts';
import { captureCtx } from './helpers.ts';

const RADIX = 'https://raw.githubusercontent.com/radix-ui/colors/main/LICENSE';
const LUCIDE = 'https://lucide.dev/license';
const PRETENDARD = 'raw.githubusercontent.com/orioncactus/pretendard/main/LICENSE';

interface Tok {
  value?: string;
  role?: string;
  on?: string;
  name?: string;
  source: string;
  license: string;
}
interface Tokens {
  colors: { light: Record<string, Tok>; dark?: Record<string, Tok> };
  fonts: Tok[];
  icons: Tok[];
}

function c(value: string, role: string, on?: string): Tok {
  return on === undefined
    ? { value, role, source: RADIX, license: 'MIT' }
    : { value, role, on, source: RADIX, license: 'MIT' };
}

function validTokens(): Tokens {
  return {
    colors: {
      light: {
        'bg-app': c('#fcfcfd', 'surface'),
        'bg-sidebar': c('#f9f9fb', 'surface'),
        text: c('#1c2024', 'text', 'bg-app'),
        'text-muted': c('#60646c', 'text', 'bg-sidebar'),
        'accent-text': c('#0d3d38', 'text', 'bg-app'),
        'focus-ring': c('#0d7d6e', 'nontext', 'bg-app'),
      },
      dark: {
        'bg-app': c('#111113', 'surface'),
        'bg-sidebar': c('#18191b', 'surface'),
        text: c('#edeef0', 'text', 'bg-app'),
        'text-muted': c('#b0b4ba', 'text', 'bg-sidebar'),
        'focus-ring': c('#1c8a7b', 'nontext', 'bg-app'),
      },
    },
    fonts: [{ name: 'Pretendard', source: PRETENDARD, license: 'OFL-1.1' }],
    icons: [{ name: 'Lucide', source: LUCIDE, license: 'ISC' }],
  };
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'design-tokens-'));
  mkdirSync(join(root, 'apps/web/src'), { recursive: true });
  return root;
}

function writeFile(root: string, rel: string, body = 'x'): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function writeTokens(root: string, tokens: unknown): void {
  writeFile(root, 'apps/web/src/ui/tokens.ts', `export const tokens = ${JSON.stringify(tokens)};\n`);
}

function withTokens(fn: (t: Tokens) => void): (root: string) => void {
  return (root) => {
    const t = validTokens();
    fn(t);
    writeTokens(root, t);
  };
}

async function exec(root: string): Promise<{ code: number; text: string }> {
  const ctx = captureCtx(process.cwd(), {});
  const code = await run(['--root', root], ctx);
  return { code, text: ctx.lines.join('\n') };
}

describe('check-design-tokens', () => {
  it('(a) skeleton root without tokens.ts passes with notice', async () => {
    const r = await exec(makeRoot());
    expect(r.code).toBe(0);
    expect(r.text).toContain('토큰 모듈 미구현');
  });

  it('defaults --root to ctx.cwd', async () => {
    const ctx = captureCtx(makeRoot(), {});
    expect(await run([], ctx)).toBe(0);
  });

  it('(b) valid tokens + allowed assets pass', async () => {
    const root = makeRoot();
    writeTokens(root, validTokens());
    writeFile(root, 'apps/web/public/icons/logo.svg');
    writeFile(root, 'apps/web/public/favicon.ico');
    writeFile(root, 'apps/web/public/fonts/Pretendard.woff2');
    writeFile(root, 'docs/shot.png');
    writeFile(root, 'qa/manual/a/shot.jpg');
    writeFile(root, 'node_modules/pkg/x.png');
    writeFile(root, 'apps/web/node_modules/pkg/y.png');
    writeFile(root, 'apps/web/public/manifest.webmanifest', JSON.stringify({ name: 'Chatter', short_name: 'Chat' }));
    const r = await exec(root);
    expect(r.text).toContain('OK');
    expect(r.code).toBe(0);
  });

  const violations: Array<[string, (root: string) => void, string]> = [
    ['purple dark surface', withTokens((t) => { t.colors.dark!['bg-sidebar'] = c('#3b1d4a', 'surface'); }), 'bg-sidebar'],
    ['purple light surface', withTokens((t) => { t.colors.light['bg-app'] = c('#3b1d4a', 'surface'); }), 'bg-app'],
    ['low contrast text', withTokens((t) => { t.colors.light['text-muted'] = c('#b0b4ba', 'text', 'bg-sidebar'); }), 'text-muted'],
    ['low contrast nontext', withTokens((t) => { t.colors.dark!['focus-ring'] = c('#222225', 'nontext', 'bg-app'); }), 'focus-ring'],
    ['missing on target', withTokens((t) => { t.colors.dark!.text = c('#edeef0', 'text', 'nope'); }), 'nope'],
    ['missing license', withTokens((t) => { t.fonts[0] = { name: 'Pretendard', source: PRETENDARD, license: '' }; }), 'license'],
    ['disallowed source', withTokens((t) => { t.icons[0] = { name: 'X', source: 'https://example.com/icons/LICENSE', license: 'MIT' }; }), 'example.com'],
    ['missing scheme', withTokens((t) => { delete t.colors.dark; }), 'dark'],
    ['invalid hex', withTokens((t) => { t.colors.light.text = c('red', 'text', 'bg-app'); }), 'red'],
    ['png outside allowed dirs', (root) => writeFile(root, 'apps/web/src/logo.png'), 'logo.png'],
    ['woff outside woff2 rule', (root) => writeFile(root, 'apps/web/public/fonts/a.woff'), 'a.woff'],
    ['mp3 anywhere', (root) => writeFile(root, 'docs/ping.mp3'), 'ping.mp3'],
    ['manifest forbidden name', (root) => writeFile(root, 'apps/web/public/manifest.webmanifest', JSON.stringify({ name: 'My SLACK clone', short_name: 'ok' })), 'manifest'],
  ];

  for (const [label, setup, needle] of violations) {
    it(`(c) violation: ${label}`, async () => {
      const root = makeRoot();
      setup(root);
      const r = await exec(root);
      expect(r.code).toBe(1);
      expect(r.text).toContain(needle);
    });
  }

  it('(d) nonexistent root → 1', async () => {
    expect((await exec(join(tmpdir(), 'no-such-root-xyz-123'))).code).toBe(1);
  });

  it('(d) root without apps/web → 1', async () => {
    expect((await exec(mkdtempSync(join(tmpdir(), 'design-tokens-')))).code).toBe(1);
  });

  it('(d) tokens.ts syntax error → 1', async () => {
    const root = makeRoot();
    writeFile(root, 'apps/web/src/ui/tokens.ts', 'export const tokens = {{{ ;\n');
    expect((await exec(root)).code).toBe(1);
  });

  it('(d) tokens.ts without tokens export → 1', async () => {
    const root = makeRoot();
    writeFile(root, 'apps/web/src/ui/tokens.ts', 'export const other = 1;\n');
    expect((await exec(root)).code).toBe(1);
  });

  it('(d) malformed manifest JSON → 1', async () => {
    const root = makeRoot();
    writeFile(root, 'apps/web/public/manifest.webmanifest', '{ not json');
    expect((await exec(root)).code).toBe(1);
  });

  it('passes on the real repo root', async () => {
    const repo = fileURLToPath(new URL('../..', import.meta.url));
    expect((await exec(repo)).code).toBe(0);
  });
});
