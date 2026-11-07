/** W-13 복원 드릴 SQL 생성기. 스키마 이름은 `drill_(src|orig)_<소문자·숫자>`만 허용하고 그대로 인용한다. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SNAPSHOT_TABLES } from './compare.ts';

const DRILL_SCHEMA = /^drill_(src|orig)_[a-z0-9]{4,32}$/;

export function assertDrillSchema(name: string): string {
  if (!DRILL_SCHEMA.test(name)) throw new Error(`드릴 스키마 이름 형식 위반: ${name}`);
  return name;
}

/** 마이그레이션 파일을 이름 순으로 읽는다(실행기와 같은 순서형 파일 규칙). */
export function readMigrations(root: string): string[] {
  const dir = join(root, 'apps', 'server', 'migrations');
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  if (files.length === 0) throw new Error('마이그레이션 파일이 없습니다');
  return files.map((f) => readFileSync(join(dir, f), 'utf8'));
}

const id = (n: number): string => `'00000000-0000-4000-8000-${String(n).padStart(12, '0')}'`;
const ts = (sec: number): string => `'2026-01-01T00:00:${String(sec).padStart(2, '0')}Z'`;

const W = id(1);
const [U1, U2, U3] = [id(11), id(12), id(13)];
const [CH, DM] = [id(21), id(22)];
const [M1, M2, M3, M4, M6, M7] = [id(31), id(32), id(33), id(34), id(36), id(37)];

/** 합성 데이터: 채널·DM·답글·수정·삭제(tombstone)·멘션·읽음 커서·change 커서. 실데이터 없음. */
export const SEED_SQL = `
INSERT INTO workspaces (id, name, created_at) VALUES (${W}, 'drill', ${ts(0)});
INSERT INTO users (id, email_norm, display_name, password_hash, status) VALUES
  (${U1}, 'drill-a@example.invalid', 'A', 'x', 'active'),
  (${U2}, 'drill-b@example.invalid', 'B', 'x', 'active'),
  (${U3}, 'drill-c@example.invalid', 'C', 'x', 'disabled');
INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${W}, ${U1}, 'owner'), (${W}, ${U2}, 'member'), (${W}, ${U3}, 'member');
INSERT INTO conversations (id, workspace_id, kind, name, name_norm, normalized_pair_key, last_seq, created_at) VALUES
  (${CH}, ${W}, 'channel', 'General', 'general', NULL, 4, ${ts(1)}),
  (${DM}, ${W}, 'dm', NULL, NULL, ${U1.slice(0, -1)}:${U2.slice(1)}, 2, ${ts(2)});
INSERT INTO conversation_members (conversation_id, user_id, joined_at, joined_seq, left_at) VALUES
  (${CH}, ${U1}, ${ts(1)}, 0, NULL), (${CH}, ${U2}, ${ts(1)}, 0, NULL), (${CH}, ${U3}, ${ts(1)}, 0, ${ts(9)}),
  (${DM}, ${U1}, ${ts(2)}, 0, NULL), (${DM}, ${U2}, ${ts(2)}, 0, NULL);
INSERT INTO messages (id, conversation_id, seq, author_id, client_message_id, thread_root_id, body, created_at, edited_at, deleted_at) VALUES
  (${M1}, ${CH}, 1, ${U1}, ${id(41)}, NULL, 'hello @B', ${ts(3)}, NULL, NULL),
  (${M2}, ${CH}, 2, ${U2}, ${id(42)}, NULL, 'edited body', ${ts(4)}, ${ts(10)}, NULL),
  (${M3}, ${CH}, 3, ${U1}, ${id(43)}, NULL, NULL, ${ts(5)}, NULL, ${ts(11)}),
  (${M4}, ${CH}, 4, ${U2}, ${id(44)}, ${M1}, 'reply @A', ${ts(6)}, NULL, NULL),
  (${M6}, ${DM}, 1, ${U1}, ${id(46)}, NULL, 'dm one', ${ts(7)}, NULL, NULL),
  (${M7}, ${DM}, 2, ${U2}, ${id(47)}, NULL, 'dm two edited', ${ts(8)}, ${ts(12)}, NULL);
INSERT INTO message_mentions (message_id, user_id) VALUES (${M1}, ${U2}), (${M4}, ${U1});
INSERT INTO conversation_changes (change_id, conversation_id, message_id, op, created_at) VALUES
  (1, ${CH}, ${M1}, 'create', ${ts(3)}), (2, ${CH}, ${M2}, 'create', ${ts(4)}), (3, ${CH}, ${M3}, 'create', ${ts(5)}),
  (4, ${CH}, ${M4}, 'create', ${ts(6)}), (5, ${DM}, ${M6}, 'create', ${ts(7)}), (6, ${DM}, ${M7}, 'create', ${ts(8)}),
  (7, ${CH}, ${M2}, 'edit', ${ts(10)}), (8, ${CH}, ${M3}, 'delete', ${ts(11)}), (9, ${DM}, ${M7}, 'edit', ${ts(12)});
UPDATE sync_clock SET last_change_id = 9 WHERE id = 1;
INSERT INTO conversation_read_state (conversation_id, user_id, last_read_seq, updated_at) VALUES
  (${CH}, ${U1}, 4, ${ts(13)}), (${CH}, ${U2}, 2, ${ts(13)}), (${DM}, ${U2}, 1, ${ts(13)});
INSERT INTO thread_read_state (root_message_id, user_id, last_read_seq, updated_at) VALUES (${M1}, ${U1}, 4, ${ts(14)});
INSERT INTO thread_unread_targets (root_message_id, user_id, qualified_at) VALUES (${M1}, ${U1}, ${ts(6)});
`;

/** 스키마 생성 + 마이그레이션 + 합성 데이터. psql `-1`(단일 트랜잭션)로 실행한다. */
export function seedSql(schema: string, migrations: readonly string[]): string {
  const s = assertDrillSchema(schema);
  return [`CREATE SCHEMA "${s}";`, `SET search_path TO "${s}";`, ...migrations, SEED_SQL].join('\n');
}

/** 스냅숏 테이블 전체를 JSON 한 줄로 내보낸다(행 순서 무관 — 대조 쪽에서 정렬). */
export function snapshotSql(schema: string): string {
  const s = assertDrillSchema(schema);
  const parts = SNAPSHOT_TABLES.map((t) => `'${t}', (SELECT coalesce(json_agg(t), '[]'::json) FROM "${s}"."${t}" t)`);
  return `SELECT json_build_object(${parts.join(', ')});`;
}

export function renameSql(from: string, to: string): string {
  return `ALTER SCHEMA "${assertDrillSchema(from)}" RENAME TO "${assertDrillSchema(to)}";`;
}

export function dropSql(schemas: readonly string[]): string {
  return schemas.map((s) => `DROP SCHEMA IF EXISTS "${assertDrillSchema(s)}" CASCADE;`).join('\n');
}

/** 잔여 드릴 스키마 수(이름 패턴 `drill_%`). */
export const RESIDUE_SQL = `SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'drill\\_%';`;
