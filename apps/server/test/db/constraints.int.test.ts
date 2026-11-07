import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { createTestSchema, withClient, type TestSchema } from '../support/test-db.js';

/** TRD §2 제약을 DB가 직접 거부하는지 확인한다. 거부 사례는 SQLSTATE와 제약 이름을 함께 단언한다. */
const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

const NOW = '2026-11-07T00:00:00Z';
const ids = {
  workspace: randomUUID(),
  otherWorkspace: randomUUID(),
  alice: randomUUID(),
  bob: randomUUID(),
  general: randomUUID(),
  random: randomUUID(),
  otherGeneral: randomUUID(),
  dm: randomUUID(),
  root: randomUUID(),
  root2: randomUUID(),
  reply: randomUUID(),
  tombstone: randomUUID(),
  randomRoot: randomUUID(),
  dmMessage: randomUUID(),
};

interface MessageInput {
  readonly id?: string;
  readonly conversation: string;
  readonly seq: number;
  readonly author?: string;
  readonly clientMessageId?: string;
  readonly threadRoot?: string | null;
  readonly body?: string | null;
  readonly deletedAt?: string | null;
}

const INSERT_MESSAGE = `INSERT INTO messages
  (id, conversation_id, seq, author_id, client_message_id, thread_root_id, body, created_at, deleted_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

function messageParams(input: MessageInput): unknown[] {
  return [
    input.id ?? randomUUID(),
    input.conversation,
    input.seq,
    input.author ?? ids.alice,
    input.clientMessageId ?? randomUUID(),
    input.threadRoot ?? null,
    input.body === undefined ? 'hello' : input.body,
    NOW,
    input.deletedAt ?? null,
  ];
}

const INSERT_CONVERSATION = `INSERT INTO conversations
  (id, workspace_id, kind, name, name_norm, normalized_pair_key, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`;

describe('db constraints (0001)', () => {
  let schema: TestSchema;

  async function sql(text: string, params: unknown[] = []): Promise<pg.QueryResult> {
    return schema.pool.query(text, params);
  }

  async function expectRejected(text: string, params: unknown[], code: string, constraint: string): Promise<void> {
    const error = await sql(text, params).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error, `거부되어야 함: ${constraint}`).toBeInstanceOf(pg.DatabaseError);
    const { code: actualCode, constraint: actualConstraint } = error as pg.DatabaseError;
    expect({ code: actualCode, constraint: actualConstraint }).toEqual({ code, constraint });
  }

  beforeAll(async () => {
    schema = await createTestSchema();
    await withClient(schema.pool, (client) => migrate(client));
    await sql('INSERT INTO workspaces (id, name, created_at) VALUES ($1, $2, $3), ($4, $5, $3)', [
      ids.workspace,
      'w1',
      NOW,
      ids.otherWorkspace,
      'w2',
    ]);
    await sql(
      `INSERT INTO users (id, email_norm, display_name, password_hash, status)
       VALUES ($1, 'alice@example.test', 'Alice', 'x', 'active'), ($2, 'bob@example.test', 'Bob', 'x', 'disabled')`,
      [ids.alice, ids.bob],
    );
    await sql(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`, [
      ids.workspace,
      ids.alice,
      ids.bob,
    ]);
    await sql(INSERT_CONVERSATION, [ids.general, ids.workspace, 'channel', 'General', 'general', null, NOW]);
    await sql(INSERT_CONVERSATION, [ids.random, ids.workspace, 'channel', 'Random', 'random', null, NOW]);
    // 같은 name_norm이라도 다른 workspace면 허용.
    await sql(INSERT_CONVERSATION, [ids.otherGeneral, ids.otherWorkspace, 'channel', 'General', 'general', null, NOW]);
    await sql(INSERT_CONVERSATION, [ids.dm, ids.workspace, 'dm', null, null, 'pair-ab', NOW]);
    await sql(INSERT_MESSAGE, messageParams({ id: ids.root, conversation: ids.general, seq: 1 }));
    await sql(INSERT_MESSAGE, messageParams({ id: ids.root2, conversation: ids.general, seq: 2 }));
    await sql(INSERT_MESSAGE, messageParams({ id: ids.reply, conversation: ids.general, seq: 3, threadRoot: ids.root }));
    await sql(
      INSERT_MESSAGE,
      messageParams({ id: ids.tombstone, conversation: ids.general, seq: 4, body: null, deletedAt: NOW }),
    );
    await sql(INSERT_MESSAGE, messageParams({ id: ids.randomRoot, conversation: ids.random, seq: 1 }));
    await sql(INSERT_MESSAGE, messageParams({ id: ids.dmMessage, conversation: ids.dm, seq: 1, author: ids.bob }));
  });

  afterAll(async () => {
    await schema?.drop();
  });

  it('accepts the valid fixture: channels, DM, root, reply, tombstone', async () => {
    const conversations = await sql('SELECT kind, count(*)::int AS n FROM conversations GROUP BY kind ORDER BY kind');
    expect(conversations.rows).toEqual([
      { kind: 'channel', n: 3 },
      { kind: 'dm', n: 1 },
    ]);
    const messages = await sql('SELECT id, thread_root_id, body, deleted_at IS NOT NULL AS deleted FROM messages');
    const byId = new Map(messages.rows.map((row) => [row.id, row]));
    expect(messages.rows).toHaveLength(6);
    expect(byId.get(ids.reply)).toMatchObject({ thread_root_id: ids.root, body: 'hello', deleted: false });
    expect(byId.get(ids.tombstone)).toMatchObject({ body: null, deleted: true });
  });

  it('① rejects a thread root from another conversation (23503 messages_thread_root_fkey)', async () => {
    await expectRejected(
      INSERT_MESSAGE,
      messageParams({ conversation: ids.random, seq: 2, threadRoot: ids.root }),
      FK_VIOLATION,
      'messages_thread_root_fkey',
    );
  });

  it('② rejects a reply to a reply (23503 messages_thread_root_top_level_fkey)', async () => {
    await expectRejected(
      INSERT_MESSAGE,
      messageParams({ conversation: ids.general, seq: 5, threadRoot: ids.reply }),
      FK_VIOLATION,
      'messages_thread_root_top_level_fkey',
    );
  });

  it('② rejects turning a root that has replies into a reply (23503 messages_thread_root_top_level_fkey)', async () => {
    await expectRejected(
      'UPDATE messages SET thread_root_id = $1 WHERE id = $2',
      [ids.root2, ids.root],
      FK_VIOLATION,
      'messages_thread_root_top_level_fkey',
    );
  });

  it('③ rejects a duplicate DM normalized_pair_key (23505 conversations_dm_pair_key_key)', async () => {
    await expectRejected(
      INSERT_CONVERSATION,
      [randomUUID(), ids.workspace, 'dm', null, null, 'pair-ab', NOW],
      UNIQUE_VIOLATION,
      'conversations_dm_pair_key_key',
    );
  });

  it('④ rejects a duplicate channel name_norm in the same workspace (23505 conversations_channel_name_norm_key)', async () => {
    await expectRejected(
      INSERT_CONVERSATION,
      [randomUUID(), ids.workspace, 'channel', 'GENERAL', 'general', null, NOW],
      UNIQUE_VIOLATION,
      'conversations_channel_name_norm_key',
    );
  });

  it('⑤ rejects body together with deleted_at (23514 messages_tombstone_check)', async () => {
    await expectRejected(
      INSERT_MESSAGE,
      messageParams({ conversation: ids.general, seq: 6, body: 'still here', deletedAt: NOW }),
      CHECK_VIOLATION,
      'messages_tombstone_check',
    );
  });

  it('⑤ rejects body NULL without deleted_at (23514 messages_tombstone_check)', async () => {
    await expectRejected(
      INSERT_MESSAGE,
      messageParams({ conversation: ids.general, seq: 7, body: null }),
      CHECK_VIOLATION,
      'messages_tombstone_check',
    );
  });

  it('⑥ accepts 4000 code points and rejects 4001 (23514 messages_body_length_check)', async () => {
    const astral = '\u{1F600}';
    const ok = astral.repeat(4000);
    expect(ok.length).toBe(8000);
    await sql(INSERT_MESSAGE, messageParams({ conversation: ids.general, seq: 8, body: ok }));
    await expectRejected(
      INSERT_MESSAGE,
      messageParams({ conversation: ids.general, seq: 9, body: astral.repeat(4001) }),
      CHECK_VIOLATION,
      'messages_body_length_check',
    );
  });

  it('⑥ rejects an empty body (23514 messages_body_nonempty_check)', async () => {
    await expectRejected(
      INSERT_MESSAGE,
      messageParams({ conversation: ids.general, seq: 10, body: '' }),
      CHECK_VIOLATION,
      'messages_body_nonempty_check',
    );
  });

  it('⑦ rejects a duplicate (conversation_id, author_id, client_message_id) (23505 messages_client_message_key)', async () => {
    const clientMessageId = randomUUID();
    await sql(INSERT_MESSAGE, messageParams({ conversation: ids.general, seq: 11, clientMessageId }));
    await expectRejected(
      INSERT_MESSAGE,
      messageParams({ conversation: ids.general, seq: 12, clientMessageId }),
      UNIQUE_VIOLATION,
      'messages_client_message_key',
    );
  });

  it('rejects a duplicate (conversation_id, seq) (23505 messages_conversation_seq_key)', async () => {
    await expectRejected(
      INSERT_MESSAGE,
      messageParams({ conversation: ids.general, seq: 1 }),
      UNIQUE_VIOLATION,
      'messages_conversation_seq_key',
    );
  });

  it('⑧ rejects sync_clock id=2 (23514 sync_clock_singleton_check) and a second id=1 (23505)', async () => {
    await expectRejected('INSERT INTO sync_clock (id) VALUES (2)', [], CHECK_VIOLATION, 'sync_clock_singleton_check');
    await expectRejected('INSERT INTO sync_clock (id) VALUES (1)', [], UNIQUE_VIOLATION, 'sync_clock_pkey');
  });

  it('⑨ rejects values outside the status/role/kind/op enums (23514)', async () => {
    await expectRejected(
      `INSERT INTO users (id, email_norm, display_name, password_hash, status) VALUES ($1, 'c@example.test', 'C', 'x', 'banned')`,
      [randomUUID()],
      CHECK_VIOLATION,
      'users_status_check',
    );
    await expectRejected(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [ids.otherWorkspace, ids.alice],
      CHECK_VIOLATION,
      'workspace_members_role_check',
    );
    await expectRejected(
      INSERT_CONVERSATION,
      [randomUUID(), ids.workspace, 'group', 'G', 'g', null, NOW],
      CHECK_VIOLATION,
      'conversations_kind_check',
    );
    await expectRejected(
      `INSERT INTO conversation_changes (change_id, conversation_id, message_id, op, created_at) VALUES (1, $1, $2, 'upsert', $3)`,
      [ids.general, ids.root, NOW],
      CHECK_VIOLATION,
      'conversation_changes_op_check',
    );
  });

  it('⑩ rejects a channel without name_norm and a DM without pair key (23514 conversations_kind_keys_check)', async () => {
    await expectRejected(
      INSERT_CONVERSATION,
      [randomUUID(), ids.workspace, 'channel', 'nameless', null, null, NOW],
      CHECK_VIOLATION,
      'conversations_kind_keys_check',
    );
    await expectRejected(
      INSERT_CONVERSATION,
      [randomUUID(), ids.workspace, 'dm', null, null, null, NOW],
      CHECK_VIOLATION,
      'conversations_kind_keys_check',
    );
  });

  it('rejects a change row whose message belongs to another conversation (23503 conversation_changes_message_fkey)', async () => {
    await expectRejected(
      `INSERT INTO conversation_changes (change_id, conversation_id, message_id, op, created_at) VALUES (2, $1, $2, 'create', $3)`,
      [ids.random, ids.root, NOW],
      FK_VIOLATION,
      'conversation_changes_message_fkey',
    );
  });
});
