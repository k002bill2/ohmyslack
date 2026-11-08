import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBotEvents, createBotService, type BotService } from '../../src/modules/bots/index.js';
import { login, sessionCookie } from '../support/auth-app.js';
import { setupAuthInt, teardownAuthInt, type AuthIntContext } from '../auth/auth-int-harness.js';

/**
 * 봇 계정(TRD §5-2 1항, DEV_DESIGN 6-2 FR-BOT-01). 지정 테스트(「…비활성화 후 5초 안에 봇 연결이 닫힌다」)는
 * 봇 WS가 생기는 p1-w18b 레인에서 완성한다. 이 파일은 계정·로그인 거부·세션 0·close 훅 호출을 일반 이름으로 검증한다.
 */
const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'owner-fixture-password';
const ANY_PASSWORD = 'bot-login-attempt-1';

let ctx: AuthIntContext | undefined;
let service: BotService;
let closed: { botUserId: string; tokenIds: readonly string[] }[];

beforeEach(async () => {
  ctx = await setupAuthInt(OWNER_EMAIL, OWNER_PASSWORD);
  const workspaceId = randomUUID();
  await ctx.schema.pool.query("INSERT INTO workspaces (id, name, created_at) VALUES ($1, 'WS', now())", [workspaceId]);
  await ctx.schema.pool.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [
    workspaceId,
    ctx.userId,
  ]);
  const events = createBotEvents();
  closed = [];
  events.onConnectionsClose((e) => closed.push(e));
  service = createBotService({ pool: ctx.schema.pool, events });
});

afterEach(async () => {
  await teardownAuthInt(ctx);
  ctx = undefined;
});

async function sessionCount(userId: string): Promise<number> {
  const res = await (ctx as AuthIntContext).schema.pool.query('SELECT 1 FROM sessions WHERE user_id = $1', [userId]);
  return res.rowCount ?? 0;
}

function errorShape(res: { statusCode: number; json: () => unknown }): unknown {
  const body = res.json() as { error: { code: string; request_id: string } };
  return { status: res.statusCode, code: body.error.code, keys: Object.keys(body.error).sort() };
}

describe('봇 계정과 로그인 경계', () => {
  it('봇 이메일 로그인은 없는 계정·틀린 비밀번호와 같은 401 오류로 거부되고 세션 행·세션 쿠키가 생기지 않는다', async () => {
    const c = ctx as AuthIntContext;
    const bot = await service.createBot({ displayName: 'Jarvis', slug: 'jarvis' });
    const botRes = await login(c.app, 'jarvis@bot.invalid', ANY_PASSWORD);
    const missingRes = await login(c.app, 'nobody@example.test', ANY_PASSWORD);
    const wrongRes = await login(c.app, OWNER_EMAIL, `${OWNER_PASSWORD}-wrong`);
    expect(errorShape(botRes)).toEqual(errorShape(missingRes));
    expect(errorShape(botRes)).toEqual(errorShape(wrongRes));
    expect(errorShape(botRes)).toEqual({ status: 401, code: 'invalid_credentials', keys: ['code', 'request_id'] });
    expect(sessionCookie(botRes)).toBeUndefined();
    expect(botRes.headers['set-cookie']).toBeUndefined();
    expect(await sessionCount(bot.botUserId)).toBe(0);
  });

  it('봇 로그인 실패는 사람 실패와 같은 계정별 제한에 기록되어 같은 횟수 뒤 429가 된다', async () => {
    const c = ctx as AuthIntContext;
    await service.createBot({ displayName: 'Jarvis', slug: 'jarvis' });
    const statuses: number[] = [];
    const humanStatuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await login(c.app, 'jarvis@bot.invalid', `${ANY_PASSWORD}-${i}`)).statusCode);
      humanStatuses.push((await login(c.app, 'ghost@example.test', `${ANY_PASSWORD}-${i}`)).statusCode);
    }
    expect(statuses).toEqual(humanStatuses);
    expect(statuses.at(-1)).toBe(429);
  });

  it('봇은 kind=bot·해시 NULL·<slug>@bot.invalid·workspace member로 생기고 owner DM이 함께 생긴다', async () => {
    const c = ctx as AuthIntContext;
    const bot = await service.createBot({ displayName: 'Jarvis', slug: 'jarvis' });
    const user = await c.schema.pool.query<{ kind: string; password_hash: string | null; email_norm: string; status: string }>(
      'SELECT kind, password_hash, email_norm, status FROM users WHERE id = $1',
      [bot.botUserId],
    );
    expect(user.rows[0]).toEqual({ kind: 'bot', password_hash: null, email_norm: 'jarvis@bot.invalid', status: 'active' });
    const role = await c.schema.pool.query<{ role: string }>('SELECT role FROM workspace_members WHERE user_id = $1', [bot.botUserId]);
    expect(role.rows.map((r) => r.role)).toEqual(['member']);
    const members = await c.schema.pool.query<{ user_id: string }>(
      "SELECT cm.user_id FROM conversation_members cm JOIN conversations cv ON cv.id = cm.conversation_id WHERE cv.id = $1 AND cv.kind = 'dm' ORDER BY cm.user_id",
      [bot.dmConversationId],
    );
    expect(members.rows.map((r) => r.user_id).sort()).toEqual([bot.botUserId, c.userId].sort());
  });

  it('비활성화하면 status=disabled, 미폐기 토큰 전부 폐기, 열린 봇 연결 close 훅이 그 토큰 id로 호출된다', async () => {
    const c = ctx as AuthIntContext;
    const bot = await service.createBot({ displayName: 'Jarvis', slug: 'jarvis' });
    const first = await service.issueToken(bot.botUserId, 'adapter');
    const second = await service.issueToken(bot.botUserId, 'rotate');
    await service.disableBot(bot.botUserId);
    const status = await c.schema.pool.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [bot.botUserId]);
    expect(status.rows[0]?.status).toBe('disabled');
    const live = await c.schema.pool.query('SELECT 1 FROM bot_tokens WHERE bot_user_id = $1 AND revoked_at IS NULL', [bot.botUserId]);
    expect(live.rowCount).toBe(0);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.botUserId).toBe(bot.botUserId);
    expect([...(closed[0]?.tokenIds ?? [])].sort()).toEqual([first.tokenId, second.tokenId].sort());
    expect(await service.verifyToken(first.token)).toBeUndefined();
    expect(await service.verifyToken(second.token)).toBeUndefined();
  });
});
