import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseFlags, type RunContext } from './lib/cli.ts';

/**
 * CLEANROOM.md 5절 코드 블록의 grep 패턴·제외 목록을 읽어 실행하고 종료 코드로 분기한다(정본: DEV_DESIGN §5-1).
 * 금지 문자열은 이 파일에 다시 적지 않는다.
 */
export interface CleanroomSpec {
  readonly flags: string;
  readonly pattern: string;
  readonly excludeDirs: readonly string[];
  readonly excludeFiles: readonly string[];
}

export class SpecError extends Error {}

export function parseCleanroomSpec(markdown: string): CleanroomSpec {
  const section = /^## 5\.[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(markdown)?.[1];
  const block = section === undefined ? undefined : /```bash\n([\s\S]*?)```/.exec(section)?.[1];
  if (block === undefined) throw new SpecError('CLEANROOM.md 5절 bash 코드 블록을 찾을 수 없습니다');
  const command = block.replace(/\\\n/g, ' ');
  const grep = /\bgrep\s+(-[A-Za-z]+)\s+'([^']+)'/.exec(command);
  if (grep?.[1] === undefined || grep[2] === undefined) {
    throw new SpecError('CLEANROOM.md 5절에서 grep 패턴을 해석할 수 없습니다');
  }
  const dirs = /--exclude-dir=\{([^}]*)\}/.exec(command)?.[1] ?? /--exclude-dir=(\S+)/.exec(command)?.[1];
  const files = [...command.matchAll(/--exclude=(\S+)/g)].map((m) => m[1] ?? '');
  return {
    flags: grep[1],
    pattern: grep[2],
    excludeDirs: (dirs ?? '').split(',').map((d) => d.trim()).filter((d) => d !== ''),
    excludeFiles: files.filter((f) => f !== ''),
  };
}

function grepArgs(spec: CleanroomSpec): string[] {
  return [
    spec.flags,
    ...spec.excludeDirs.map((d) => `--exclude-dir=${d}`),
    ...spec.excludeFiles.map((f) => `--exclude=${f}`),
    '-e',
    spec.pattern,
    '.',
  ];
}

function loadSpec(path: string, ctx: RunContext): CleanroomSpec | undefined {
  try {
    return parseCleanroomSpec(readFileSync(path, 'utf8'));
  } catch (error) {
    ctx.err(`check:cleanroom: 실행 오류 — 5절 블록 읽기 실패: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export async function run(argv: readonly string[], ctx: RunContext): Promise<number> {
  const flags = parseFlags(argv);
  const root = flags.root === undefined ? ctx.cwd : flags.root;
  const specPath = flags.cleanroom ?? join(root, 'CLEANROOM.md');
  const spec = loadSpec(isAbsolute(specPath) ? specPath : join(ctx.cwd, specPath), ctx);
  if (spec === undefined) return 1;
  if (!existsSync(root)) {
    ctx.err(`check:cleanroom: 실행 오류 — 대상 경로 없음: ${root}`);
    return 1;
  }
  const res = spawnSync('grep', grepArgs(spec), { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status === 1) {
    ctx.out('CLEANROOM OK');
    return 0;
  }
  if (res.status === 0) {
    for (const line of res.stdout.split('\n').filter((l) => l !== '')) ctx.err(`위반: ${line}`);
    ctx.err('check:cleanroom: 실패 — CLEANROOM 5절 금지 표식 발견');
    return 1;
  }
  const why = res.error?.message ?? (res.signal === null ? `grep 종료 코드 ${String(res.status)}` : `신호 ${res.signal}`);
  ctx.err(`check:cleanroom: 실행 오류 — ${why} ${res.stderr ?? ''}`.trim());
  return 1;
}
