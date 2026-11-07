import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { parseFlags, type RunContext } from './lib/cli.ts';

/** DEV_DESIGN §2-2 B7 / §5-1 `check:no-persist-cache`. eslint.config.js의 금지 목록과 동일하다. */
const PERSIST_GLOBALS = ['localStorage', 'sessionStorage', 'indexedDB', 'caches'] as const;
const SW_FILE = 'apps/web/src/features/pwa/sw.ts';
const CHECKPOINT_FILE = 'apps/web/src/features/sync/checkpoint.ts';
const EXCEPTIONS: Readonly<Record<string, string>> = {
  [SW_FILE]: 'caches',
  [CHECKPOINT_FILE]: 'localStorage',
};
const EVIDENCE: Readonly<Record<string, string>> = {
  [SW_FILE]: 'apps/web/test/pwa/sw',
  [CHECKPOINT_FILE]: 'apps/web/test/sync/checkpoint',
};
const SW_NAME = /^(sw|service-worker|workbox-.*)\.js$/;
/** precache manifest의 URL 항목만 본다(런타임 우회 코드의 "/api" 문자열은 정상). */
const API_PRECACHE = /\burl["']?\s*:\s*["']\/api(?:[/"'?]|$)/;

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function walk(dir: string, accept: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(abs, accept));
    else if (accept(entry.name)) found.push(abs);
  }
  return found;
}

/** 줄·블록 주석을 공백으로 바꾼다(줄 번호 유지). 문자열 안의 `//`는 주석으로 보지 않는다. */
export function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] ?? '';
    const next = source[i + 1] ?? '';
    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        out += next;
        i += 1;
      } else if (ch === quote) quote = null;
    } else if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else {
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      out += ch;
    }
  }
  return out;
}

function scanSource(root: string): string[] {
  const srcDir = join(root, 'apps/web/src');
  const violations: string[] = [];
  for (const abs of walk(srcDir, (n) => n.endsWith('.ts') || n.endsWith('.tsx'))) {
    const rel = toPosix(relative(root, abs));
    const allowed = EXCEPTIONS[rel];
    const lines = stripComments(readFileSync(abs, 'utf8')).split('\n');
    lines.forEach((line, idx) => {
      for (const name of PERSIST_GLOBALS) {
        if (name === allowed) continue;
        if (new RegExp(`\\b${name}\\b`).test(line)) {
          violations.push(`${rel}:${idx + 1} — 영속 저장소 \`${name}\` 사용 금지 (B7)`);
        }
      }
    });
  }
  return violations;
}

interface VitestReport {
  readonly testResults?: readonly {
    readonly name?: string;
    readonly assertionResults?: readonly { readonly status?: string }[];
  }[];
}

function passingTestFiles(root: string): string[] {
  const dir = join(root, 'reports');
  if (!existsSync(dir)) return [];
  const names: string[] = [];
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    let parsed: VitestReport;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as VitestReport;
    } catch {
      continue;
    }
    for (const result of parsed.testResults ?? []) {
      const asserts = result.assertionResults ?? [];
      const ok = asserts.length > 0 && asserts.every((a) => a.status === 'passed');
      if (ok && typeof result.name === 'string') names.push(toPosix(result.name));
    }
  }
  return names;
}

function checkEvidence(root: string, ctx: RunContext): string[] {
  const present = [SW_FILE, CHECKPOINT_FILE].filter((f) => existsSync(join(root, f)));
  if (present.length === 0) {
    ctx.out('sw.ts/checkpoint.ts 미구현 — 단위 테스트 증거 검사 건너뜀');
    return [];
  }
  const passing = passingTestFiles(root);
  const violations: string[] = [];
  for (const file of present) {
    const needle = EVIDENCE[file] ?? '';
    if (!passing.some((name) => name.includes(needle))) {
      violations.push(`${file} — reports/*.json에 통과한 단위 테스트(${needle}) 증거 없음`);
    }
  }
  return violations;
}

function checkDist(root: string, ctx: RunContext): string[] {
  const dist = join(root, 'apps/web/dist');
  if (!existsSync(dist)) {
    ctx.out('빌드 산출물 없음 — 건너뜀');
    return [];
  }
  const swFiles = walk(dist, (n) => SW_NAME.test(n) || n.includes('precache'));
  if (swFiles.length === 0) {
    ctx.out('SW 산출물 없음');
    return [];
  }
  return swFiles
    .filter((abs) => {
      const content = readFileSync(abs, 'utf8');
      return API_PRECACHE.test(content);
    })
    .map((abs) => `${toPosix(relative(root, abs))} — SW precache에 /api 항목 존재 (${basename(abs)})`);
}

export async function run(argv: readonly string[], ctx: RunContext): Promise<number> {
  const root = resolve(ctx.cwd, parseFlags(argv)['root'] ?? ctx.cwd);
  try {
    const srcDir = join(root, 'apps/web/src');
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
      throw new Error(`${srcDir} 디렉터리가 없습니다 (apps/web/src 필요)`);
    }
    const violations = [...scanSource(root), ...checkEvidence(root, ctx), ...checkDist(root, ctx)];
    if (violations.length > 0) {
      for (const v of violations) ctx.err(`위반: ${v}`);
      ctx.err(`check:no-persist-cache 실패 — 위반 ${violations.length}건`);
      return 1;
    }
    ctx.out('check:no-persist-cache OK');
    return 0;
  } catch (error) {
    ctx.err(`실행 오류: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
