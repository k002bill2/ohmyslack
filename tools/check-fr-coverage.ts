import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { parseFlags, type RunContext } from './lib/cli.ts';

/** DEV_DESIGN §5-1 `check:fr-coverage`: PRD P0 FR ↔ 6-2 지정 테스트 매핑을 진행/판정 모드로 검사한다. */

const EXPECTED_HEADER = ['FR', '지정 테스트 이름', '계층·파일', '실행', '필수 보조 증거', '수동'] as const;
const SCAN_ROOTS = ['apps/server/test', 'apps/web/test', 'e2e', 'perf', 'tools/test'] as const;
const QA_FIELDS = ['실행자', '일시', '기기', '접속 경로', '절차', '기대 결과', '실제 결과', '판정', '증거'] as const;
const FR_ID = /^FR-[A-Z]+-\d+$/;
const QA_ID = /QA-[A-Z0-9]+(?:-[A-Z0-9]+)*/;
const MODIFIERS = new Set(['skip', 'todo', 'only']);
/** 6-2 지정 파일이 vitest가 수집하는 TS 소스인지. 아니면(예: `.sh`) 수동 증거로 판정한다. */
const VITEST_SOURCE = /\.tsx?$/;

export interface DesignRow {
  readonly fr: string;
  readonly name: string;
  readonly file: string;
  readonly run: string;
  readonly aux: readonly string[];
  readonly manual: string | undefined;
}

interface Occurrence {
  readonly file: string;
  readonly modifier: string | undefined;
}

interface Assertion {
  readonly file: string;
  readonly title: string;
  readonly fullName: string;
  readonly status: string;
}

/** `|`로 셀을 나누되 백틱 안의 `|`는 나누지 않는다. */
export function splitCells(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inTick = false;
  for (const ch of line.trim()) {
    if (ch === '`') inTick = !inTick;
    if (ch === '|' && !inTick) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells.slice(1, -1);
}

function backticks(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
}

export function parsePrd(text: string): Set<string> {
  const p0 = new Set<string>();
  let rows = 0;
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = splitCells(line);
    if (cells.length !== 5 || !FR_ID.test(cells[0] ?? '')) continue;
    rows += 1;
    if (cells[2] === 'P0') p0.add(cells[0] ?? '');
  }
  if (rows === 0) throw new Error('PRD FR 표 파싱 실패: FR 행 0개');
  return p0;
}

function toRow(line: string): DesignRow {
  const cells = splitCells(line);
  const [fr = '', nameCell = '', fileCell = '', runCell = '', auxCell = '', manualCell = ''] = cells;
  const name = backticks(nameCell)[0];
  if (cells.length !== 6 || !FR_ID.test(fr) || name === undefined) {
    throw new Error(`6-2 행 형식 불일치: ${line.slice(0, 60)}`);
  }
  const aux = backticks(auxCell).filter((t) => /\.tsx?$/.test(t) && !t.startsWith('pnpm '));
  const manual = manualCell === '—' ? undefined : QA_ID.exec(manualCell)?.[0];
  return { fr, name, file: backticks(fileCell)[0] ?? '', run: runCell, aux, manual };
}

export function parseDesign(text: string): DesignRow[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('### 6-2.'));
  if (start < 0) throw new Error('DEV_DESIGN 6-2 절을 찾지 못함');
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('### '));
  const section = end < 0 ? rest : rest.slice(0, end);
  const headerAt = section.findIndex((l) => l.trim().startsWith('|'));
  const header = headerAt < 0 ? [] : splitCells(section[headerAt] ?? '');
  if (header.join('|') !== EXPECTED_HEADER.join('|')) {
    throw new Error(`6-2 표 머리 형식 불일치: ${header.join(' | ')}`);
  }
  const rows: DesignRow[] = [];
  for (const line of section.slice(headerAt + 2)) {
    if (!line.trim().startsWith('|')) break;
    rows.push(toRow(line));
  }
  if (rows.length === 0) throw new Error('6-2 표에 행이 없음');
  return rows;
}

function listSources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules') return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return listSources(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

interface Declaration {
  readonly title: string;
  readonly modifier: string | undefined;
}

/** `it`/`test`와 `.skip/.todo/.only/.each` 변형 호출식이면 수식자(skip·todo·only 중 첫째)를 돌려준다. */
function declarationCallee(expr: ts.Expression): { modifier: string | undefined } | undefined {
  let node: ts.Expression = expr;
  let modifier: string | undefined;
  for (;;) {
    if (ts.isCallExpression(node)) node = node.expression; // it.each(table)(...)
    else if (ts.isPropertyAccessExpression(node)) {
      if (MODIFIERS.has(node.name.text)) modifier = node.name.text;
      else if (node.name.text !== 'each') return undefined;
      node = node.expression;
    } else break;
  }
  return ts.isIdentifier(node) && (node.text === 'it' || node.text === 'test') ? { modifier } : undefined;
}

/** AST에서 첫 인자가 문자열·치환 없는 템플릿 리터럴인 it/test 선언만 모은다. 주석·일반 문자열은 세지 않는다. */
export function findDeclarations(text: string, file: string): Declaration[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Declaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      const callee = declarationCallee(node.expression);
      if (callee !== undefined && first !== undefined && ts.isStringLiteralLike(first)) {
        found.push({ title: first.text, modifier: callee.modifier });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function scanSources(root: string, names: readonly string[]): Map<string, Occurrence[]> {
  const result = new Map<string, Occurrence[]>(names.map((n) => [n, []]));
  const files = SCAN_ROOTS.flatMap((r) => listSources(join(root, r)));
  for (const file of files) {
    for (const d of findDeclarations(readFileSync(file, 'utf8'), file)) {
      result.get(d.title)?.push({ file, modifier: d.modifier });
    }
  }
  return result;
}

function loadReports(dir: string): Assertion[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  return files.flatMap((f) => {
    const data = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { testResults?: unknown };
    if (!Array.isArray(data.testResults)) return [];
    return (data.testResults as { name?: string; assertionResults?: Partial<Assertion>[] }[]).flatMap((tr) =>
      (tr.assertionResults ?? []).map((a) => ({
        file: tr.name ?? '',
        title: a.title ?? '',
        fullName: a.fullName ?? '',
        status: a.status ?? '',
      })),
    );
  });
}

/** 6-2 행의 파일 경로와 정확한 테스트 제목이 모두 맞는 결과만 실행 증거로 인정한다. */
function resultsFor(row: DesignRow, assertions: readonly Assertion[]): Assertion[] {
  const suffix = `/${row.file}`;
  return assertions.filter((a) => a.title === row.name && a.file.replace(/\\/g, '/').endsWith(suffix));
}

function setDiff(prd: ReadonlySet<string>, rows: readonly DesignRow[]): string[] {
  const design = new Set(rows.map((r) => r.fr));
  const errors: string[] = [];
  for (const id of prd) if (!design.has(id)) errors.push(`PRD P0에만 있음: ${id}`);
  for (const id of design) if (!prd.has(id)) errors.push(`6-2에만 있음: ${id}`);
  return errors;
}

function duplicateNames(rows: readonly DesignRow[]): string[] {
  const seen = new Set<string>();
  return rows.flatMap((r) => {
    if (seen.has(r.name)) return [`6-2 지정 테스트 이름 중복: ${r.fr}`];
    seen.add(r.name);
    return [];
  });
}

interface Evaluation {
  readonly errors: string[];
  readonly warnings: string[];
  readonly missing: DesignRow[];
  readonly found: number;
}

function evaluateRow(row: DesignRow, occ: readonly Occurrence[], assertions: readonly Assertion[], gate: boolean, ev: Evaluation): void {
  if (occ.length === 0 || !VITEST_SOURCE.test(row.file)) {
    ev.missing.push(row);
    return;
  }
  if (occ.length > 1) ev.errors.push(`${row.fr}: 지정 테스트 이름이 ${occ.length}곳에 있음`);
  for (const o of occ) if (o.modifier !== undefined) ev.errors.push(`${row.fr}: 지정 테스트가 ${o.modifier} 상태 (${o.file})`);
  const results = resultsFor(row, assertions);
  if (results.some((a) => a.status !== 'passed')) {
    ev.errors.push(`${row.fr}: 지정 테스트 실행 결과 실패`);
  } else if (results.length === 0) {
    const msg = `${row.fr}: 지정 테스트 실행 결과 없음`;
    if (row.run === 'G1' && !gate) ev.warnings.push(msg);
    else ev.errors.push(msg);
  }
}

function checkAux(root: string, rows: readonly DesignRow[], assertions: readonly Assertion[]): string[] {
  return rows.flatMap((row) =>
    row.aux.flatMap((rel) => {
      if (!existsSync(join(root, rel))) return [`${row.fr}: 보조 증거 파일 없음 ${rel}`];
      const own = assertions.filter((a) => a.file.endsWith(`/${rel}`));
      if (own.length === 0 || own.some((a) => a.status !== 'passed')) return [`${row.fr}: 보조 증거 미통과 ${rel}`];
      return [];
    }),
  );
}

function checkQa(root: string, id: string): string[] {
  const path = join(root, 'qa', 'manual', `${id}.md`);
  if (!existsSync(path)) return [`수동 증거 없음: qa/manual/${id}.md`];
  const text = readFileSync(path, 'utf8');
  const missing = QA_FIELDS.filter((f) => !new RegExp(`${f}[^:|\\n]*[:|][ \\t]*[^\\s|]`).test(text));
  const errors = missing.map((f) => `${id}: 필수 필드 비어 있음 ${f}`);
  if (!/판정\s*[:|]\s*`?PASS\b/.test(text)) errors.push(`${id}: 판정이 PASS가 아님`);
  return errors;
}

/** vitest 대상이 아닌 지정 파일(예: 드릴 `.sh`): 파일 존재 + 같은 행 수동 QA PASS(checkQa)로 판정한다. */
function manualOnly(root: string, row: DesignRow): string[] {
  const errors: string[] = [];
  if (!existsSync(join(root, row.file))) errors.push(`${row.fr}: 지정 파일 없음 ${row.file}`);
  if (row.manual === undefined) errors.push(`${row.fr}: 수동 증거 지정 없음`);
  return errors;
}

function gateChecks(root: string, rows: readonly DesignRow[], assertions: readonly Assertion[], ev: Evaluation): string[] {
  const errors = ev.missing.flatMap((r) => (VITEST_SOURCE.test(r.file) ? [`${r.fr}: 지정 테스트 미발견`] : manualOnly(root, r)));
  errors.push(...checkAux(root, rows, assertions));
  const qaIds = rows.flatMap((r) => (r.manual === undefined ? [] : [r.manual]));
  for (const id of [...qaIds, 'QA-BOOT-01']) errors.push(...checkQa(root, id));
  return errors;
}

function report(ctx: RunContext, ev: Evaluation, total: number): void {
  for (const w of ev.warnings) ctx.out(`경고: ${w}`);
  if (ev.missing.length > 0) {
    ctx.out(`미구현 ${ev.missing.length}개:`);
    for (const r of ev.missing) ctx.out(`  - ${r.fr}`);
  }
  ctx.out(`P0 FR ${total}개 / 구현 ${ev.found} / 미구현 ${ev.missing.length}`);
  for (const e of ev.errors) ctx.err(`실패: ${e}`);
}

function check(root: string, flags: Readonly<Record<string, string>>, gate: boolean, ctx: RunContext): number {
  const prd = parsePrd(readFileSync(resolve(root, flags['prd'] ?? 'docs/02-prd/PRD.md'), 'utf8'));
  const rows = parseDesign(readFileSync(resolve(root, flags['design'] ?? 'docs/04-dev-design/DEV_DESIGN.md'), 'utf8'));
  const assertions = loadReports(resolve(root, flags['reports'] ?? 'reports'));
  const occurrences = scanSources(root, rows.map((r) => r.name));
  const ev: Evaluation = { errors: [...setDiff(prd, rows), ...duplicateNames(rows)], warnings: [], missing: [], found: 0 };
  for (const row of rows) evaluateRow(row, occurrences.get(row.name) ?? [], assertions, gate, ev);
  const final: Evaluation = { ...ev, found: rows.length - ev.missing.length };
  if (gate) final.errors.push(...gateChecks(root, rows, assertions, final));
  report(ctx, final, rows.length);
  return final.errors.length > 0 ? 1 : 0;
}

export async function run(argv: readonly string[], ctx: RunContext): Promise<number> {
  const flags = parseFlags(argv);
  const mode = flags['mode'];
  if (mode !== 'progress' && mode !== 'gate') {
    ctx.err('사용법: check-fr-coverage --mode=progress|gate [--root dir] [--prd path] [--design path] [--reports dir]');
    return 1;
  }
  try {
    return check(resolve(ctx.cwd, flags['root'] ?? '.'), flags, mode === 'gate', ctx);
  } catch (error) {
    ctx.err(`스캐너 오류: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
