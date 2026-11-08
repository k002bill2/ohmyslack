import type pg from 'pg';

/**
 * bots 저장소(pg). 모든 SQL은 파라미터 바인딩만 쓴다. 토큰 원문은 어떤 쿼리에도 넘기지 않고 해시만 바인딩한다.
 * 트랜잭션 안 함수는 받은 client만 쓴다(풀 고갈 시 교착 방지).
 */
export const BOT_EMAIL_DOMAIN = '@bot.invalid';

type Db = pg.Pool | pg.PoolClient;

export interface BotRow {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly status: 'active' | 'disabled';
  readonly liveTokenCount: number;
}

export async function workspaceIds(client: pg.PoolClient): Promise<readonly string[]> {
  const res = await client.query<{ id: string }>('SELECT id FROM workspaces ORDER BY created_at, id');
  return res.rows.map((r) => r.id);
}

/** 워크스페이스의 활성 owner. 여러 명이면 가장 앞의 id(단일 사용자 운영에서는 1명). */
export async function activeOwnerId(client: pg.PoolClient, workspaceId: string): Promise<string | undefined> {
  const res = await client.query<{ user_id: string }>(
    `SELECT wm.user_id FROM workspace_members wm JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = $1 AND wm.role = 'owner' AND u.status = 'active' ORDER BY wm.user_id LIMIT 1`,
    [workspaceId],
  );
  return res.rows[0]?.user_id;
}

export async function emailTaken(client: pg.PoolClient, emailNorm: string): Promise<boolean> {
  const res = await client.query('SELECT 1 FROM users WHERE email_norm = $1', [emailNorm]);
  return (res.rowCount ?? 0) > 0;
}

/** 봇 users 행 + workspace_members(member). password_hash는 NULL(봇은 비밀번호 로그인 경로가 없다). */
export async function insertBotUser(
  client: pg.PoolClient,
  bot: { readonly id: string; readonly workspaceId: string; readonly emailNorm: string; readonly displayName: string },
): Promise<void> {
  await client.query(
    "INSERT INTO users (id, email_norm, display_name, password_hash, status, kind) VALUES ($1, $2, $3, NULL, 'active', 'bot')",
    [bot.id, bot.emailNorm, bot.displayName],
  );
  await client.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [
    bot.workspaceId,
    bot.id,
  ]);
}

/**
 * owner–봇 DM. 사람 `POST /api/dms`(conversations repo openDm + joinIn)와 같은 행을 같은 트랜잭션에서 쓴다:
 * conversations(kind dm, pair key) → 각 멤버 joined_seq = last_seq, 읽음 cursor = last_seq. conversation_changes는 쓰지 않는다.
 */
export async function insertOwnerDm(
  client: pg.PoolClient,
  dm: { readonly id: string; readonly workspaceId: string; readonly pairKey: string; readonly memberIds: readonly string[]; readonly at: Date },
): Promise<void> {
  await client.query(
    "INSERT INTO conversations (id, workspace_id, kind, normalized_pair_key, created_at) VALUES ($1, $2, 'dm', $3, $4)",
    [dm.id, dm.workspaceId, dm.pairKey, dm.at],
  );
  for (const userId of dm.memberIds) {
    const conv = await client.query<{ last_seq: string }>(
      'SELECT last_seq::text AS last_seq FROM conversations WHERE id = $1 FOR UPDATE',
      [dm.id],
    );
    const lastSeq = conv.rows[0]?.last_seq ?? '0';
    await client.query(
      'INSERT INTO conversation_members (conversation_id, user_id, joined_at, joined_seq, left_at) VALUES ($1, $2, $3, $4, NULL)',
      [dm.id, userId, dm.at, lastSeq],
    );
    await client.query(
      'INSERT INTO conversation_read_state (conversation_id, user_id, last_read_seq, updated_at) VALUES ($1, $2, $3, $4)',
      [dm.id, userId, lastSeq, dm.at],
    );
  }
}

/** 봇 users 행을 잠근다. 발급·회전·비활성화가 이 행에서 직렬화된다. 없으면 undefined. */
export async function lockBot(client: pg.PoolClient, botUserId: string): Promise<'active' | 'disabled' | undefined> {
  const res = await client.query<{ status: 'active' | 'disabled' }>(
    "SELECT status FROM users WHERE id = $1 AND kind = 'bot' FOR UPDATE",
    [botUserId],
  );
  return res.rows[0]?.status;
}

export async function liveTokenIds(client: pg.PoolClient, botUserId: string): Promise<readonly string[]> {
  const res = await client.query<{ id: string }>(
    'SELECT id FROM bot_tokens WHERE bot_user_id = $1 AND revoked_at IS NULL ORDER BY created_at, id',
    [botUserId],
  );
  return res.rows.map((r) => r.id);
}

export async function insertToken(
  client: pg.PoolClient,
  token: { readonly id: string; readonly botUserId: string; readonly tokenHash: string; readonly label: string; readonly at: Date },
): Promise<void> {
  await client.query(
    'INSERT INTO bot_tokens (id, bot_user_id, token_hash, label, created_at) VALUES ($1, $2, $3, $4, $5)',
    [token.id, token.botUserId, token.tokenHash, token.label, token.at],
  );
}

/** 미폐기면 폐기하고 소유 봇 id를 돌려준다. 없거나 이미 폐기면 undefined. */
export async function revokeTokenRow(db: Db, tokenId: string, at: Date): Promise<string | undefined> {
  const res = await db.query<{ bot_user_id: string }>(
    'UPDATE bot_tokens SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING bot_user_id',
    [tokenId, at],
  );
  return res.rows[0]?.bot_user_id;
}

export async function tokenExists(db: Db, tokenId: string): Promise<boolean> {
  const res = await db.query('SELECT 1 FROM bot_tokens WHERE id = $1', [tokenId]);
  return (res.rowCount ?? 0) > 0;
}

/** 비활성화 + 미폐기 토큰 전부 폐기(호출자가 같은 트랜잭션에서 lockBot을 먼저 잡는다). 폐기한 토큰 id를 돌려준다. */
export async function disableBotRows(client: pg.PoolClient, botUserId: string, at: Date): Promise<readonly string[]> {
  await client.query("UPDATE users SET status = 'disabled' WHERE id = $1 AND kind = 'bot'", [botUserId]);
  const res = await client.query<{ id: string }>(
    'UPDATE bot_tokens SET revoked_at = $2 WHERE bot_user_id = $1 AND revoked_at IS NULL RETURNING id',
    [botUserId, at],
  );
  return res.rows.map((r) => r.id);
}

/** 봇 목록. 토큰 해시·라벨은 조회하지 않고 미폐기 개수만 센다. */
export async function listBotRows(db: Db): Promise<readonly BotRow[]> {
  const res = await db.query<{ id: string; email_norm: string; display_name: string; status: 'active' | 'disabled'; live: number }>(
    `SELECT u.id, u.email_norm, u.display_name, u.status,
       (SELECT count(*)::int FROM bot_tokens t WHERE t.bot_user_id = u.id AND t.revoked_at IS NULL) AS live
     FROM users u WHERE u.kind = 'bot' ORDER BY u.email_norm`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    slug: r.email_norm.endsWith(BOT_EMAIL_DOMAIN) ? r.email_norm.slice(0, -BOT_EMAIL_DOMAIN.length) : r.email_norm,
    displayName: r.display_name,
    status: r.status,
    liveTokenCount: r.live,
  }));
}

export async function botIdBySlug(db: Db, slug: string): Promise<string | undefined> {
  const res = await db.query<{ id: string }>("SELECT id FROM users WHERE email_norm = $1 AND kind = 'bot'", [
    `${slug}${BOT_EMAIL_DOMAIN}`,
  ]);
  return res.rows[0]?.id;
}

/** 해시 일치 + 미폐기 + 활성 봇이면 last_used_at을 갱신하고 식별자를 돌려준다(한 문장). */
export async function touchLiveToken(
  db: Db,
  tokenHash: string,
  at: Date,
): Promise<{ readonly botUserId: string; readonly tokenId: string } | undefined> {
  const res = await db.query<{ id: string; bot_user_id: string }>(
    `UPDATE bot_tokens t SET last_used_at = $2 FROM users u
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND u.id = t.bot_user_id AND u.kind = 'bot' AND u.status = 'active'
     RETURNING t.id, t.bot_user_id`,
    [tokenHash, at],
  );
  const row = res.rows[0];
  return row === undefined ? undefined : { botUserId: row.bot_user_id, tokenId: row.id };
}
