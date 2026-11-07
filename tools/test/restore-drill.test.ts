import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run as checkFrCoverage } from '../check-fr-coverage.ts';
import { drillTarget, envFileBody, run } from '../restore-drill/cli.ts';
import { compareSnapshots, ITEMS, parseSnapshot, SNAPSHOT_TABLES, type Snapshot } from '../restore-drill/compare.ts';
import { assertDrillSchema, dropSql, readMigrations, renameSql, seedSql, snapshotSql } from '../restore-drill/sql.ts';
import { captureCtx } from './helpers.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const SECRET = 'S3cr3t-drill-pw';
const TEST_URL = `postgres://drill_user:${SECRET}@127.0.0.1:5432/ohmyslack_test`;

const CH = 'c-ch';
const DM = 'c-dm';

/** 모든 대조 항목이 1행 이상 나오는 최소 스냅숏. */
function baseSnapshot(): Snapshot {
  return {
    conversations: [
      { id: CH, kind: 'channel', normalized_pair_key: null, last_seq: 2 },
      { id: DM, kind: 'dm', normalized_pair_key: 'a:b', last_seq: 1 },
    ],
    conversation_members: [
      { conversation_id: DM, user_id: 'a', joined_at: 't0', joined_seq: 0, left_at: null },
      { conversation_id: DM, user_id: 'b', joined_at: 't0', joined_seq: 0, left_at: null },
      { conversation_id: CH, user_id: 'a', joined_at: 't0', joined_seq: 0, left_at: null },
    ],
    messages: [
      { id: 'm1', conversation_id: CH, seq: 1, author_id: 'a', client_message_id: 'k1', thread_root_id: null, body: 'hi', created_at: 't1', edited_at: 't3', deleted_at: null },
      { id: 'm2', conversation_id: CH, seq: 2, author_id: 'b', client_message_id: 'k2', thread_root_id: null, body: null, created_at: 't2', edited_at: null, deleted_at: 't4' },
      { id: 'm3', conversation_id: DM, seq: 1, author_id: 'a', client_message_id: 'k3', thread_root_id: null, body: 'dm', created_at: 't2', edited_at: null, deleted_at: null },
    ],
    message_mentions: [{ message_id: 'm1', user_id: 'b' }],
    conversation_changes: [
      { change_id: 1, conversation_id: CH, message_id: 'm1', op: 'create' },
      { change_id: 2, conversation_id: CH, message_id: 'm2', op: 'delete' },
    ],
    sync_clock: [{ id: 1, last_change_id: 2 }],
    conversation_read_state: [{ conversation_id: CH, user_id: 'a', last_read_seq: 2 }],
    thread_read_state: [{ root_message_id: 'm1', user_id: 'a', last_read_seq: 1 }],
  };
}

function withMessages(s: Snapshot, edit: (rows: Snapshot['messages']) => Snapshot['messages']): Snapshot {
  return { ...s, messages: edit(s['messages'] ?? []) };
}

const last = (lines: readonly string[]): string => lines[lines.length - 1] ?? '';

describe('restore-drill compare', () => {
  it('FR-OPS-02 격리 복원본과 원본의 메시지·수정/삭제 상태·DM 멤버십·읽음 커서·seq·change 커서가 일치한다', () => {
    const orig = baseSnapshot();
    const reordered: Snapshot = Object.fromEntries(Object.entries(orig).map(([k, v]) => [k, [...v].reverse()]));
    const result = compareSnapshots(orig, reordered);
    expect(result.ok).toBe(true);
    expect(last(result.lines)).toBe(`DRILL OK ${ITEMS.length}/${ITEMS.length}`);
    expect(ITEMS.map((i) => i.name)).toEqual(
      expect.arrayContaining(['messages', 'edit_delete_state', 'dm_membership', 'read_cursor', 'seq', 'change_cursor']),
    );
  });

  it('fails only the item whose deleted_at differs', () => {
    const orig = baseSnapshot();
    const restored = withMessages(orig, (rows) => rows.map((r) => (r['id'] === 'm2' ? { ...r, deleted_at: 't9' } : r)));
    const result = compareSnapshots(orig, restored);
    expect(result.ok).toBe(false);
    expect(last(result.lines)).toBe('DRILL FAILED edit_delete_state');
  });

  it('fails edit state, read cursor, dm membership and change cursor mismatches', () => {
    const orig = baseSnapshot();
    const cases: [Snapshot, string][] = [
      [withMessages(orig, (rows) => rows.map((r) => (r['id'] === 'm1' ? { ...r, edited_at: null } : r))), 'edit_delete_state'],
      [{ ...orig, conversation_read_state: [{ conversation_id: CH, user_id: 'a', last_read_seq: 1 }] }, 'read_cursor'],
      [{ ...orig, conversation_members: (orig['conversation_members'] ?? []).slice(1) }, 'dm_membership'],
      [{ ...orig, sync_clock: [{ id: 1, last_change_id: 1 }] }, 'change_cursor'],
      [{ ...orig, conversations: (orig['conversations'] ?? []).map((c) => ({ ...c, last_seq: 9 })) }, 'seq'],
    ];
    for (const [restored, item] of cases) {
      expect(last(compareSnapshots(orig, restored).lines)).toBe(`DRILL FAILED ${item}`);
    }
  });

  it('fails when a row is missing from the restored copy', () => {
    const orig = baseSnapshot();
    const restored = withMessages(orig, (rows) => rows.filter((r) => r['id'] !== 'm3'));
    const result = compareSnapshots(orig, restored);
    expect(result.ok).toBe(false);
    expect(last(result.lines)).toMatch(/^DRILL FAILED messages, edit_delete_state, seq$/);
    expect(result.lines.join('\n')).toContain('messages: 원본 3행 / 복원 2행 / 불일치');
  });

  it('fails when an item has no rows in the original (no vacuous OK)', () => {
    const empty: Snapshot = Object.fromEntries(SNAPSHOT_TABLES.map((t) => [t, []]));
    const result = compareSnapshots(empty, empty);
    expect(result.ok).toBe(false);
    expect(last(result.lines)).toContain('messages(원본 0행)');
  });

  it('parses snapshots and rejects a missing table', () => {
    expect(Object.keys(parseSnapshot(JSON.stringify(baseSnapshot())))).toEqual(expect.arrayContaining([...SNAPSHOT_TABLES]));
    expect(() => parseSnapshot('{"messages":[]}')).toThrow('conversations');
    expect(() => parseSnapshot('[]')).toThrow('객체');
  });
});

describe('restore-drill sql', () => {
  it('accepts only drill_* schema names', () => {
    expect(assertDrillSchema('drill_src_ab12cd34')).toBe('drill_src_ab12cd34');
    for (const bad of ['public', 'drill_src_', 'drill_src_x"; DROP', 't_1', 'drill_other_abcd']) {
      expect(() => assertDrillSchema(bad)).toThrow('형식 위반');
    }
  });

  it('builds seed, snapshot, rename and drop SQL scoped to the drill schema', () => {
    const seed = seedSql('drill_src_abcd1234', readMigrations(REPO));
    expect(seed.startsWith('CREATE SCHEMA "drill_src_abcd1234";\nSET search_path TO "drill_src_abcd1234";')).toBe(true);
    expect(seed).toContain('CREATE TABLE messages');
    expect(seed).toMatch(/deleted_at\) VALUES/);
    for (const t of SNAPSHOT_TABLES) expect(snapshotSql('drill_orig_abcd1234')).toContain(`"drill_orig_abcd1234"."${t}"`);
    expect(renameSql('drill_src_abcd1234', 'drill_orig_abcd1234')).toBe('ALTER SCHEMA "drill_src_abcd1234" RENAME TO "drill_orig_abcd1234";');
    expect(dropSql(['drill_src_abcd1234'])).toBe('DROP SCHEMA IF EXISTS "drill_src_abcd1234" CASCADE;');
  });
});

describe('restore-drill target and cli', () => {
  it('accepts only ohmyslack_test and never echoes the password', () => {
    expect(drillTarget(TEST_URL)).toEqual({ user: 'drill_user', password: SECRET, database: 'ohmyslack_test' });
    for (const bad of [
      `postgres://u:${SECRET}@127.0.0.1:5432/ohmyslack`,
      `postgres://u:${SECRET}@127.0.0.1:5432/other_test`,
      `postgres://u:${SECRET}@10.0.0.5:5432/ohmyslack_test`,
      undefined,
    ]) {
      let message = '';
      try {
        drillTarget(bad);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain('대상 DB 거부');
      expect(message).not.toContain(SECRET);
    }
    expect(envFileBody(drillTarget(TEST_URL))).toContain(`PGPASSWORD=${SECRET}\nPGDATABASE=ohmyslack_test\n`);
  });

  it('writes the env file with mode 600 and refuses to overwrite', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'drill-env-')), 'pg.env');
    const ctx = captureCtx(REPO, { TEST_DATABASE_URL: TEST_URL });
    expect(await run(['env-file', path], ctx)).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toContain('PGUSER=drill_user');
    expect(await run(['env-file', path], ctx)).toBe(1);
    expect(ctx.lines.join('\n')).not.toContain(SECRET);
  });

  it('compare command prints DRILL lines and exits by result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drill-cmp-'));
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    writeFileSync(a, JSON.stringify(baseSnapshot()));
    writeFileSync(b, JSON.stringify(withMessages(baseSnapshot(), (rows) => rows.slice(1))));
    const ok = captureCtx(REPO, {});
    expect(await run(['compare', a, a], ok)).toBe(0);
    expect(last(ok.lines)).toBe(`DRILL OK ${ITEMS.length}/${ITEMS.length}`);
    const bad = captureCtx(REPO, {});
    expect(await run(['compare', a, b], bad)).toBe(1);
    expect(last(bad.lines)).toMatch(/^DRILL FAILED /);
    const broken = captureCtx(REPO, {});
    expect(await run(['compare', a, join(dir, 'missing.json')], broken)).toBe(1);
    expect(last(broken.lines)).toBe('DRILL FAILED 대조 실행 오류');
  });

  it('prints SQL subcommands and rejects unknown usage', async () => {
    const ctx = captureCtx(REPO, { TEST_DATABASE_URL: TEST_URL });
    expect(await run(['check-url'], ctx)).toBe(0);
    expect(await run(['seed-sql', 'drill_src_abcd1234'], ctx)).toBe(0);
    expect(await run(['snapshot-sql', 'drill_src_abcd1234'], ctx)).toBe(0);
    expect(await run(['rename-sql', 'drill_src_abcd1234', 'drill_orig_abcd1234'], ctx)).toBe(0);
    expect(await run(['drop-sql', 'drill_src_abcd1234'], ctx)).toBe(0);
    expect(await run(['residue-sql'], ctx)).toBe(0);
    expect(await run(['seed-sql'], ctx)).toBe(1);
    expect(await run(['nope'], ctx)).toBe(1);
    expect(ctx.lines.join('\n')).not.toContain(SECRET);
  });
});

describe('restore-drill.sh --dry-run', () => {
  const drill = (url: string) =>
    spawnSync('bash', [join(REPO, 'tools/restore-drill.sh'), '--dry-run'], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, TEST_DATABASE_URL: url },
    });

  it('prints commands only, with no production DB name or secret', () => {
    const r = drill(TEST_URL);
    const output = `${r.stdout}${r.stderr}`;
    expect(r.status).toBe(0);
    expect(output).toContain('pg_dump -Fc -n drill_src_');
    expect(output).toContain('pg_restore');
    expect(output.trimEnd().endsWith('DRILL DRY-RUN')).toBe(true);
    expect(output).not.toContain(SECRET);
    expect(output).not.toMatch(/\bohmyslack\b/);
  });

  it('refuses a production database URL', () => {
    const r = drill(`postgres://u:${SECRET}@127.0.0.1:5432/ohmyslack`);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toContain(SECRET);
  });
});

describe('FR-OPS-02 coverage wiring', () => {
  it('check:fr-coverage treats FR-OPS-02 as drill + manual QA (not a vitest name)', async () => {
    const ctx = captureCtx(REPO, {});
    await checkFrCoverage(['--mode=progress', '--reports', join(tmpdir(), 'no-reports-dir')], ctx);
    const text = ctx.lines.join('\n');
    expect(text).toContain('  - FR-OPS-02');
    expect(text).not.toContain('FR-OPS-02: 지정 테스트 이름이');
  });
});
