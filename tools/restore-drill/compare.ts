/**
 * W-13 복원 드릴 대조 로직(정본: DEV_DESIGN W-13·6-2 FR-OPS-02, TRD §5 백업·복원 문단).
 * 원본·복원본 스키마의 테이블 스냅숏(JSON)을 받아 대조 항목별로 투영 → 정렬 → 해시 → 건수와 함께 비교한다.
 */
import { createHash } from 'node:crypto';

type Row = Readonly<Record<string, unknown>>;
export type Snapshot = Readonly<Record<string, readonly Row[]>>;

/** 스냅숏에 반드시 있어야 하는 테이블(snapshot-sql이 같은 목록으로 만든다). */
export const SNAPSHOT_TABLES = [
  'conversations',
  'conversation_members',
  'messages',
  'message_mentions',
  'conversation_changes',
  'sync_clock',
  'conversation_read_state',
  'thread_read_state',
] as const;

interface Item {
  readonly name: string;
  readonly project: (s: Snapshot) => readonly (readonly unknown[])[];
}

const rows = (s: Snapshot, table: string): readonly Row[] => s[table] ?? [];
const pick = (r: Row, cols: readonly string[]): unknown[] => cols.map((c) => r[c] ?? null);

function dmIds(s: Snapshot): ReadonlySet<unknown> {
  return new Set(rows(s, 'conversations').filter((c) => c['kind'] === 'dm').map((c) => c['id']));
}

/** 대조 항목. 순서는 출력 순서다. 각 항목은 원본에 1행 이상 있어야 한다(빈 대조로 OK 금지). */
export const ITEMS: readonly Item[] = [
  {
    name: 'messages',
    project: (s) =>
      rows(s, 'messages').map((r) =>
        pick(r, ['id', 'conversation_id', 'seq', 'author_id', 'client_message_id', 'thread_root_id', 'body', 'created_at']),
      ),
  },
  {
    name: 'edit_delete_state',
    project: (s) => rows(s, 'messages').map((r) => pick(r, ['id', 'edited_at', 'deleted_at', 'body'])),
  },
  {
    name: 'dm_membership',
    project: (s) => {
      const dms = dmIds(s);
      const pairs = rows(s, 'conversations').filter((c) => dms.has(c['id'])).map((c) => pick(c, ['id', 'normalized_pair_key']));
      const members = rows(s, 'conversation_members')
        .filter((m) => dms.has(m['conversation_id']))
        .map((m) => pick(m, ['conversation_id', 'user_id', 'joined_at', 'joined_seq', 'left_at']));
      return [...pairs, ...members];
    },
  },
  {
    name: 'read_cursor',
    project: (s) => [
      ...rows(s, 'conversation_read_state').map((r) => ['conv', ...pick(r, ['conversation_id', 'user_id', 'last_read_seq'])]),
      ...rows(s, 'thread_read_state').map((r) => ['thread', ...pick(r, ['root_message_id', 'user_id', 'last_read_seq'])]),
    ],
  },
  {
    name: 'seq',
    project: (s) => [
      ...rows(s, 'conversations').map((r) => ['last_seq', ...pick(r, ['id', 'last_seq'])]),
      ...rows(s, 'messages').map((r) => ['msg_seq', ...pick(r, ['conversation_id', 'seq'])]),
    ],
  },
  {
    name: 'change_cursor',
    project: (s) => [
      ...rows(s, 'conversation_changes').map((r) => ['change', ...pick(r, ['change_id', 'conversation_id', 'message_id', 'op'])]),
      ...rows(s, 'sync_clock').map((r) => ['clock', ...pick(r, ['id', 'last_change_id'])]),
    ],
  },
  {
    name: 'mentions',
    project: (s) => rows(s, 'message_mentions').map((r) => pick(r, ['message_id', 'user_id'])),
  },
];

export interface ItemDigest {
  readonly name: string;
  readonly count: number;
  readonly hash: string;
}

/** 행을 정규 문자열로 만들어 정렬한 뒤 해시한다(행 순서와 무관). */
export function digestItem(item: Item, snapshot: Snapshot): ItemDigest {
  const lines = item.project(snapshot).map((r) => JSON.stringify(r)).sort();
  const hash = createHash('sha256').update(lines.join('\n')).digest('hex');
  return { name: item.name, count: lines.length, hash };
}

export interface CompareResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

/** 원본(orig)과 복원본(restored)을 항목별로 대조한다. 마지막 줄은 `DRILL OK …` 또는 `DRILL FAILED …`. */
export function compareSnapshots(orig: Snapshot, restored: Snapshot): CompareResult {
  const lines: string[] = [];
  const failed: string[] = [];
  for (const item of ITEMS) {
    const a = digestItem(item, orig);
    const b = digestItem(item, restored);
    const match = a.count === b.count && a.hash === b.hash;
    if (a.count === 0) failed.push(`${item.name}(원본 0행)`);
    else if (!match) failed.push(item.name);
    lines.push(`${item.name}: 원본 ${a.count}행 / 복원 ${b.count}행 / ${match ? '일치' : '불일치'} ${b.hash.slice(0, 12)}`);
  }
  const ok = failed.length === 0;
  lines.push(ok ? `DRILL OK ${ITEMS.length}/${ITEMS.length}` : `DRILL FAILED ${failed.join(', ')}`);
  return { ok, lines };
}

/** psql 출력(JSON 한 줄)을 스냅숏으로 해석한다. 필수 테이블이 없으면 오류. */
export function parseSnapshot(text: string): Snapshot {
  const data = JSON.parse(text) as unknown;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('스냅숏이 객체가 아닙니다');
  const record = data as Record<string, unknown>;
  for (const t of SNAPSHOT_TABLES) {
    if (!Array.isArray(record[t])) throw new Error(`스냅숏에 테이블 배열 없음: ${t}`);
  }
  return record as Snapshot;
}
