import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from '../check-fr-coverage.ts';
import { captureCtx } from './helpers.ts';

const N1 = 'FR-TST-01 alpha works';
const N2 = 'FR-TST-02 beta works';
const HEADER = '| FR | 지정 테스트 이름 | 계층·파일 | 실행 | 필수 보조 증거 | 수동 |';
const AUX = 'apps/web/test/aux/aux.test.tsx';
const QA_FIELDS = [
  '실행자: tester',
  '일시(KST): 2026-11-07 10:00',
  '기기·OS·브라우저: macOS',
  '접속 경로: localhost',
  '절차: 1. open',
  '기대 결과: ok',
  '실제 결과: ok',
  '판정: PASS',
  '증거 경로: qa/evidence/x.png',
].join('\n');

interface Fixture {
  readonly prdP0?: readonly string[];
  readonly header?: string;
  readonly rows?: readonly string[];
  readonly sources?: Readonly<Record<string, string>>;
  readonly reports?: readonly unknown[];
  readonly qa?: Readonly<Record<string, string>>;
}

const defaultRows = [
  `| FR-TST-01 | \`${N1}\` | 통합 \`apps/server/test/a.int.test.ts\` | PR | 컴포넌트 \`${AUX}\`: x, \`pnpm check:x\` | \`QA-FR-TST-01\`: 실기 |`,
  `| FR-TST-02 | \`${N2}\` | 지연 \`perf/b.perf.ts\` | G1 | — | — |`,
];

function write(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function build(f: Fixture = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'frcov-'));
  const p0 = f.prdP0 ?? ['FR-TST-01', 'FR-TST-02'];
  const prd = [
    '| ID | 요구사항 | 우선순위 | 수용 기준 | 출처 |',
    '|---|---|---|---|---|',
    ...p0.map((id) => `| ${id} | req | P0 | ok | src |`),
    '| FR-TST-09 | later | P1 | ok | src |',
  ];
  write(root, 'docs/02-prd/PRD.md', `# PRD\n\n${prd.join('\n')}\n`);
  const table = [f.header ?? HEADER, '|---|---|---|---|---|---|', ...(f.rows ?? defaultRows)];
  write(root, 'docs/04-dev-design/DEV_DESIGN.md',
    `### 6-1. x\n\n### 6-2. 매핑\n\n${table.join('\n')}\n\n| ID | x |\n|---|---|\n| BOOT-01 | y |\n### 6-3. y\n`);
  for (const [rel, content] of Object.entries(f.sources ?? {})) write(root, rel, content);
  (f.reports ?? []).forEach((r, i) => write(root, `reports/r${i}.json`, JSON.stringify(r)));
  for (const [id, content] of Object.entries(f.qa ?? {})) write(root, `qa/manual/${id}.md`, content);
  return root;
}

function report(root: string, file: string, titles: readonly string[], status = 'passed'): unknown {
  return {
    testResults: [{
      name: join(root, file),
      assertionResults: titles.map((title) => ({ title, fullName: `suite ${title}`, status })),
    }],
  };
}

async function exec(root: string, ...argv: string[]): Promise<{ code: number; text: string }> {
  const ctx = captureCtx(root, {});
  const code = await run(argv, ctx);
  return { code, text: ctx.lines.join('\n') };
}

function fullFixture(qa: Record<string, string>): string {
  const root = build({
    sources: {
      'apps/server/test/a.int.test.ts': `it('${N1}', () => {});`,
      'perf/b.perf.ts': `test("${N2}", () => {});`,
      [AUX]: `it('aux', () => {});`,
    },
    qa,
  });
  const reports = [
    report(root, 'apps/server/test/a.int.test.ts', [N1]),
    report(root, 'perf/b.perf.ts', [N2]),
    report(root, AUX, ['aux']),
    { other: true },
  ];
  reports.forEach((r, i) => write(root, `reports/r${i}.json`, JSON.stringify(r)));
  return root;
}

describe('check-fr-coverage', () => {
  it('progress passes an empty skeleton and reports 미구현', async () => {
    const r = await exec(build(), '--mode=progress');
    expect(r.code).toBe(0);
    expect(r.text).toContain('미구현 2개');
    expect(r.text).toContain('P0 FR 2개 / 구현 0 / 미구현 2');
  });

  it('progress warns only for a discovered G1 test without result', async () => {
    const root = build({ sources: { 'perf/b.perf.ts': `test('${N2}', () => {});` } });
    const r = await exec(root, '--mode=progress');
    expect(r.code).toBe(0);
    expect(r.text).toContain('경고');
  });

  it('progress fails a discovered PR test without result', async () => {
    const root = build({ sources: { 'apps/server/test/a.int.test.ts': `it('${N1}', () => {});` } });
    expect((await exec(root, '--mode=progress')).code).toBe(1);
  });

  it('fails when the PRD P0 set differs from 6-2', async () => {
    const r = await exec(build({ prdP0: ['FR-TST-01', 'FR-TST-03'] }), '--mode=progress');
    expect(r.code).toBe(1);
    expect(r.text).toContain('FR-TST-03');
  });

  it('fails on duplicate designated names in 6-2', async () => {
    const rows = [defaultRows[0] ?? '', `| FR-TST-02 | \`${N1}\` | x \`perf/b.perf.ts\` | G1 | — | — |`];
    expect((await exec(build({ rows }), '--mode=progress')).code).toBe(1);
  });

  it('fails when a designated name occurs in two places', async () => {
    const src = `it('${N1}', () => {});`;
    const root = build({ sources: { 'apps/server/test/a.int.test.ts': src, 'e2e/c.e2e.test.ts': src } });
    expect((await exec(root, '--mode=progress')).code).toBe(1);
  });

  it('fails on a skipped designated test', async () => {
    const root = build({ sources: { 'apps/server/test/a.int.test.ts': `it.skip('${N1}', () => {});` } });
    const r = await exec(root, '--mode=progress');
    expect(r.code).toBe(1);
    expect(r.text).toContain('skip');
  });

  it('fails when a discovered designated test failed in reports', async () => {
    const root = build({ sources: { 'apps/server/test/a.int.test.ts': `it('${N1}', () => {});` } });
    write(root, 'reports/r.json', JSON.stringify(report(root, 'apps/server/test/a.int.test.ts', [N1], 'failed')));
    expect((await exec(root, '--mode=progress')).code).toBe(1);
  });

  it('fails on execution errors: missing PRD, malformed header, bad mode', async () => {
    expect((await exec(build(), '--mode=progress', '--prd', 'nope.md')).code).toBe(1);
    expect((await exec(build({ header: '| FR | 이름 | 파일 | 실행 | 보조 |' }), '--mode=progress')).code).toBe(1);
    expect((await exec(build(), '--mode=fast')).code).toBe(1);
    expect((await exec(build())).code).toBe(1);
    expect((await exec(build({ prdP0: [] }), '--mode=progress')).code).toBe(1);
  });

  it('gate passes when everything is implemented, passed and QA PASS', async () => {
    const root = fullFixture({ 'QA-FR-TST-01': QA_FIELDS, 'QA-BOOT-01': QA_FIELDS });
    const r = await exec(root, '--mode=gate');
    expect(r.text).toContain('구현 2 / 미구현 0');
    expect(r.code).toBe(0);
  });

  it('gate fails when a QA file is missing or not PASS', async () => {
    expect((await exec(fullFixture({ 'QA-BOOT-01': QA_FIELDS }), '--mode=gate')).code).toBe(1);
    const emptyLine = QA_FIELDS.replace('실행자: tester', '실행자:');
    expect((await exec(fullFixture({ 'QA-FR-TST-01': emptyLine, 'QA-BOOT-01': QA_FIELDS }), '--mode=gate')).code).toBe(1);
    const emptyCell = QA_FIELDS.replace('실행자: tester', '| 실행자 | |');
    expect((await exec(fullFixture({ 'QA-FR-TST-01': emptyCell, 'QA-BOOT-01': QA_FIELDS }), '--mode=gate')).code).toBe(1);
    const fail = QA_FIELDS.replace('판정: PASS', '판정: FAIL');
    expect((await exec(fullFixture({ 'QA-FR-TST-01': fail, 'QA-BOOT-01': QA_FIELDS }), '--mode=gate')).code).toBe(1);
  });

  it('gate fails on the unimplemented skeleton', async () => {
    expect((await exec(build(), '--mode=gate')).code).toBe(1);
  });

  describe('real repo docs', () => {
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    const emptyReports = mkdtempSync(join(tmpdir(), 'frcov-reports-'));

    it('progress exits 0 with 미구현 33', async () => {
      const r = await exec(repoRoot, '--mode=progress', '--reports', emptyReports);
      expect(r.text).toContain('미구현 33');
      expect(r.code).toBe(0);
    });

    it('gate exits 1', async () => {
      expect((await exec(repoRoot, '--mode=gate', '--reports', emptyReports)).code).toBe(1);
    });
  });
});

describe('check-fr-coverage regressions (Codex round 2)', () => {
  it('does not accept a same-titled passing test from another file as evidence', async () => {
    const root = build({ sources: { 'apps/server/test/a.int.test.ts': `it('${N1}', () => {});` } });
    write(root, 'reports/r0.json', JSON.stringify(report(root, 'apps/server/test/other.int.test.ts', [N1])));
    const res = await exec(root, '--mode=progress');
    expect(res.code).toBe(1);
  });

  it('does not accept a prefixed fullName as evidence', async () => {
    const root = build({ sources: { 'apps/server/test/a.int.test.ts': `it('${N1}', () => {});` } });
    write(root, 'reports/r0.json', JSON.stringify(report(root, 'apps/server/test/a.int.test.ts', [`x ${N1}`])));
    expect((await exec(root, '--mode=progress')).code).toBe(1);
  });

  it('counts only it/test declarations, not comments or fixture strings', async () => {
    const root = build({
      sources: {
        'apps/server/test/a.int.test.ts': `// see '${N1}'\nconst label = '${N1}';\nit('${N1}', () => {});`,
      },
    });
    write(root, 'reports/r0.json', JSON.stringify(report(root, 'apps/server/test/a.int.test.ts', [N1])));
    const res = await exec(root, '--mode=progress');
    expect(res.text).not.toContain('중복');
    expect(res.code).toBe(0);
  });
});

describe('check-fr-coverage regressions (Codex round 3)', () => {
  const FILE = 'apps/server/test/a.int.test.ts';

  async function progressWith(src: string): Promise<{ code: number; text: string }> {
    const root = build({ sources: { [FILE]: src } });
    write(root, 'reports/r0.json', JSON.stringify(report(root, FILE, [N1])));
    return exec(root, '--mode=progress');
  }

  it('ignores a commented-out declaration next to a real one', async () => {
    const res = await progressWith(`// it('${N1}', () => {});\n/* test('${N1}', () => {}); */\nit('${N1}', () => {});`);
    expect(res.text).not.toContain('곳에 있음');
    expect(res.code).toBe(0);
  });

  it('still fails on two real declarations', async () => {
    const res = await progressWith(`it('${N1}', () => {});\ntest(\`${N1}\`, () => {});`);
    expect(res.text).toContain('2곳에 있음');
    expect(res.code).toBe(1);
  });

  it('does not count a name inside a template-string fixture', async () => {
    const res = await progressWith(`const src = \`it('${N1}', () => {});\`;\nit('${N1}', () => {});`);
    expect(res.text).not.toContain('곳에 있음');
    expect(res.code).toBe(0);
  });

  it('records modifiers of each/skip variants via the AST', async () => {
    const res = await progressWith(`it.skip.each([1])('${N1}', () => {});`);
    expect(res.text).toContain('skip 상태');
    expect(res.code).toBe(1);
  });

  const DRILL = 'tools/restore-drill.sh';
  const shRows = [
    defaultRows[0] ?? '',
    `| FR-TST-02 | \`${N2}\` | 드릴 \`${DRILL}\`(합성) | G1 | — | \`QA-FR-TST-02\`: 대조 |`,
  ];

  function shFixture(qa: Record<string, string>, withDrill = true): string {
    const root = build({
      rows: shRows,
      sources: { [FILE]: `it('${N1}', () => {});`, [AUX]: `it('aux', () => {});`, ...(withDrill ? { [DRILL]: '#!/bin/sh\n' } : {}) },
      qa,
    });
    write(root, 'reports/r0.json', JSON.stringify(report(root, FILE, [N1])));
    write(root, 'reports/r1.json', JSON.stringify(report(root, AUX, ['aux'])));
    return root;
  }

  const baseQa = { 'QA-FR-TST-01': QA_FIELDS, 'QA-BOOT-01': QA_FIELDS };

  it('gate accepts a non-vitest designated file with existing file and PASS QA', async () => {
    const res = await exec(shFixture({ ...baseQa, 'QA-FR-TST-02': QA_FIELDS }), '--mode=gate');
    expect(res.text).not.toContain('실패');
    expect(res.code).toBe(0);
  });

  it('gate fails a non-vitest designated file without QA', async () => {
    const res = await exec(shFixture(baseQa), '--mode=gate');
    expect(res.text).toContain('QA-FR-TST-02');
    expect(res.code).toBe(1);
  });

  it('gate fails a non-vitest designated file that does not exist', async () => {
    const res = await exec(shFixture({ ...baseQa, 'QA-FR-TST-02': QA_FIELDS }, false), '--mode=gate');
    expect(res.text).toContain(DRILL);
    expect(res.code).toBe(1);
  });

  it('gate fails a non-vitest designated file without a manual QA id', async () => {
    const rows = [shRows[0] ?? '', `| FR-TST-02 | \`${N2}\` | 드릴 \`${DRILL}\` | G1 | — | — |`];
    const root = build({ rows, sources: { [DRILL]: '#!/bin/sh\n' } });
    const res = await exec(root, '--mode=gate');
    expect(res.text).toContain('FR-TST-02: 수동 증거 지정 없음');
    expect(res.code).toBe(1);
  });

  it('progress still reports a non-vitest designated file as 미구현', async () => {
    const res = await exec(shFixture(baseQa), '--mode=progress');
    expect(res.text).toContain('  - FR-TST-02');
    expect(res.code).toBe(0);
  });
});
