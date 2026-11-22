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

export type UploadGrant = 'ok' | 'unauthenticated' | 'not_found';

/**
 * 봇 업로드 저장 트랜잭션 안 권한 재확인 + 잠금(W-26 Codex r3). 호출자의 트랜잭션 client로만 실행한다.
 * 회수 쿼리(토큰 폐기·봇 비활성화·채널 제거)는 모두 NO KEY UPDATE라서 FOR SHARE와 충돌한다 — 여기서 잡은 잠금은 COMMIT까지
 * 회수를 기다리게 하고, 먼저 진행 중이던 회수는 커밋 뒤 WHERE 재평가로 0행이 되어 거부된다.
 * 잠금 순서는 disableBot(users → bot_tokens)·joinIn(conversations → conversation_members)과 같은 방향으로 고정한다(교착 방지).
 * 문장을 나누는 이유: JOIN … FOR SHARE는 실행 계획이 잠금 순서를 정한다.
 */
export async function lockUploadGrant(
  client: pg.PoolClient,
  grant: { readonly botUserId: string; readonly tokenId: string; readonly conversationId: string },
): Promise<UploadGrant> {
  const one = async (sql: string, params: readonly unknown[]): Promise<boolean> => ((await client.query(sql, [...params])).rowCount ?? 0) > 0;
  if (!(await one("SELECT 1 FROM users WHERE id = $1 AND kind = 'bot' AND status = 'active' FOR SHARE", [grant.botUserId]))) return 'unauthenticated';
  if (!(await one('SELECT 1 FROM bot_tokens WHERE id = $1 AND bot_user_id = $2 AND revoked_at IS NULL FOR SHARE', [grant.tokenId, grant.botUserId]))) {
    return 'unauthenticated';
  }
  // 삭제(UPDATE conversations)와 충돌하는 FOR SHARE: 가드 통과 후 삭제가 커밋되면 여기서 0행 → not_found(FR-CONV-06).
  if (!(await one('SELECT 1 FROM conversations WHERE id = $1 AND deleted_at IS NULL FOR SHARE', [grant.conversationId]))) return 'not_found';
  const member = 'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL FOR SHARE';
  return (await one(member, [grant.conversationId, grant.botUserId])) ? 'ok' : 'not_found';
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

/**
 * 주어진 토큰 ID 중 지금 유효한 것(미폐기 + 활성 봇)만 한 쿼리로(봇 WS sweep, TRD §5-2 2항). last_used_at은 바꾸지 않는다.
 */
export async function liveTokenIdsAmong(db: Db, tokenIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (tokenIds.length === 0) return new Set();
  const res = await db.query<{ id: string }>(
    `SELECT t.id FROM bot_tokens t JOIN users u ON u.id = t.bot_user_id
      WHERE t.id = ANY($1::uuid[]) AND t.revoked_at IS NULL AND u.kind = 'bot' AND u.status = 'active'`,
    [[...tokenIds]],
  );
  return new Set(res.rows.map((r) => r.id));
}

/**
 * `GET /api/bot/v1/me`(TRD §5-2 6·8항): owner = 봇이 속한 워크스페이스의 활성 owner, 대화 = **활성(left_at IS NULL)** 참여만.
 * 비활성 봇은 토큰 검증에서 이미 걸러지므로 여기서는 보지 않는다.
 */
export interface BotMeRow {
  readonly ownerUserId: string | undefined;
  readonly displayName: string;
  readonly conversations: readonly { readonly id: string; readonly kind: 'channel' | 'dm'; readonly name: string | null }[];
}

export async function botMe(db: Db, botUserId: string): Promise<BotMeRow> {
  const owner = await db.query<{ user_id: string }>(
    `SELECT wm.user_id FROM workspace_members bm
       JOIN workspace_members wm ON wm.workspace_id = bm.workspace_id AND wm.role = 'owner'
       JOIN users u ON u.id = wm.user_id AND u.status = 'active'
      WHERE bm.user_id = $1 ORDER BY wm.user_id LIMIT 1`,
    [botUserId],
  );
  const convs = await db.query<{ conversation_id: string; kind: 'channel' | 'dm'; name: string | null }>(
    `SELECT m.conversation_id, c.kind, c.name FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.user_id = $1 AND m.left_at IS NULL AND c.deleted_at IS NULL ORDER BY m.conversation_id`,
    [botUserId],
  );
  const self = await db.query<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [botUserId]);
  return {
    ownerUserId: owner.rows[0]?.user_id,
    displayName: self.rows[0]?.display_name ?? '',
    conversations: convs.rows.map((r) => ({ id: r.conversation_id, kind: r.kind, name: r.kind === 'channel' ? r.name : null })),
  };
}

/**
 * 봇 가시성(BOT_CHANNEL_SPEC §4-5, §10 Q2 ★): M.seq > joined_seq 이고 (최상위이거나 루트 seq > joined_seq).
 * 답글 seq는 항상 루트보다 크므로 `COALESCE(루트 seq, M.seq) > joined_seq` 하나로 같다. 활성 멤버십이 없으면 보이지 않는다.
 */
export async function visibleMessageIds(db: Db, botUserId: string, messageIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (messageIds.length === 0) return new Set();
  const res = await db.query<{ id: string }>(
    `SELECT m.id FROM messages m
       LEFT JOIN messages r ON r.id = m.thread_root_id
       JOIN conversation_members jm ON jm.conversation_id = m.conversation_id AND jm.user_id = $1 AND jm.left_at IS NULL
       JOIN conversations c ON c.id = m.conversation_id AND c.deleted_at IS NULL
      WHERE m.id = ANY($2::uuid[]) AND COALESCE(r.seq, m.seq) > jm.joined_seq`,
    [botUserId, [...messageIds]],
  );
  return new Set(res.rows.map((r) => r.id));
}

/** 봇의 활성 멤버십 joined_seq(BOT_CHANNEL_SPEC §4-5). seq ≤ joined_seq 원문은 항상 숨김이라 페이지 경계를 자르는 데 쓴다. 비활성이면 undefined. */
export async function joinedSeq(db: Db, botUserId: string, conversationId: string): Promise<number | undefined> {
  const res = await db.query<{ joined_seq: string | number }>(
    `SELECT m.joined_seq FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id AND c.deleted_at IS NULL
      WHERE m.conversation_id = $1 AND m.user_id = $2 AND m.left_at IS NULL`,
    [conversationId, botUserId],
  );
  const raw = res.rows[0]?.joined_seq;
  return raw === undefined ? undefined : Number(raw);
}
