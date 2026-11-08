import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBotEvents, createBotService, type BotService } from '../../src/modules/bots/index.js';
import { login, sessionCookie } from '../support/auth-app.js';
import { setupAuthInt, teardownAuthInt, type AuthIntContext } from '../auth/auth-int-harness.js';
import { closeLatency } from '../realtime/ws-int-harness.js';
import { setupBotListener, teardownBotListener, type BotListenerContext } from './bot-listener-harness.js';
import { connectedBot } from './bot-ws-harness.js';

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

/**
 * 봇 WS 연결 닫기(TRD §5-2 2항·TR-SEC-13). CLI는 별도 프로세스라 봇 리스너의 같은 프로세스 이벤트로 오지 않는다:
 * 리스너는 close 이벤트를 구독하지 않게 띄우고(sweepOnly), CLI 경로는 별도 이벤트 버스를 가진 두 번째 서비스(같은 DB)로 재현한다.
 */
describe('봇 WS 연결 닫기(별도 프로세스 경로 = sweep)', () => {
  let lc: BotListenerContext | undefined;

  afterEach(async () => {
    await teardownBotListener(lc);
    lc = undefined;
  });

  /** CLI 프로세스와 같은 조건: 같은 DB, 리스너와 공유하지 않는 이벤트 버스. */
  function cliService(c: BotListenerContext): BotService {
    return createBotService({ pool: c.conv.schema.pool, events: createBotEvents() });
  }

  it('FR-BOT-01 봇 계정은 로컬 명령으로만 생기고 이메일 로그인은 일반 실패와 같은 오류로 거부되며 세션 쿠키가 발급되지 않고 비활성화 후 5초 안에 봇 연결이 닫힌다', async () => {
    lc = await setupBotListener({ sweepOnly: true });
    const c = lc;
    // 로컬 명령(서비스 = bot-admin CLI 경로)으로 생긴 봇: kind=bot, 비밀번호 해시 없음.
    const row = await c.conv.schema.pool.query<{ kind: string; password_hash: string | null }>('SELECT kind, password_hash FROM users WHERE id = $1', [
      c.bot.botUserId,
    ]);
    expect(row.rows[0]).toEqual({ kind: 'bot', password_hash: null });
    const botRes = await login(c.conv.app, 'listener-bot@bot.invalid', ANY_PASSWORD);
    const missingRes = await login(c.conv.app, 'nobody@example.test', ANY_PASSWORD);
    expect(errorShape(botRes)).toEqual(errorShape(missingRes));
    expect(errorShape(botRes)).toMatchObject({ status: 401 });
    expect(sessionCookie(botRes)).toBeUndefined();
    expect(botRes.headers['set-cookie']).toBeUndefined();
    const sessions = await c.conv.schema.pool.query('SELECT 1 FROM sessions WHERE user_id = $1', [c.bot.botUserId]);
    expect(sessions.rowCount).toBe(0);

    const ws = await connectedBot(c.botPort, c.token);
    // 붙은 뒤 sweep 한 주기 이상 기다려도 유효 토큰은 닫히지 않는다.
    await new Promise((r) => setTimeout(r, 2500));
    expect(ws.socket.readyState).toBe(WebSocket.OPEN);
    const startedAt = performance.now();
    await cliService(c).disableBot(c.bot.botUserId);
    const { code, ms } = await closeLatency(ws, startedAt, 6000);
    expect(code).toBe(1008);
    expect(ms).toBeLessThan(5000);
  });

  it('CLI 토큰 폐기 후에도 열린 봇 WS가 5초 안에 1008로 닫힌다', async () => {
    lc = await setupBotListener({ sweepOnly: true });
    const ws = await connectedBot(lc.botPort, lc.token);
    const startedAt = performance.now();
    await cliService(lc).revokeToken(lc.tokenId);
    const { code, ms } = await closeLatency(ws, startedAt, 6000);
    expect(code).toBe(1008);
    expect(ms).toBeLessThan(5000);
  });

  it('회전 후 옛 토큰을 폐기하면 옛 토큰 WS만 5초 안에 닫히고 새 토큰 WS는 유지된다', async () => {
    lc = await setupBotListener({ sweepOnly: true });
    const cli = cliService(lc);
    const rotated = await cli.rotateToken(lc.bot.botUserId);
    const oldWs = await connectedBot(lc.botPort, lc.token);
    const newWs = await connectedBot(lc.botPort, rotated.token);
    const startedAt = performance.now();
    await cli.revokeToken(lc.tokenId);
    const { code, ms } = await closeLatency(oldWs, startedAt, 6000);
    expect(code).toBe(1008);
    expect(ms).toBeLessThan(5000);
    expect(newWs.socket.readyState).toBe(WebSocket.OPEN);
    newWs.close();
  });

  it('같은 프로세스의 비활성화는 close 이벤트로 sweep 주기를 기다리지 않고 닫힌다', async () => {
    lc = await setupBotListener();
    const ws = await connectedBot(lc.botPort, lc.token);
    const startedAt = performance.now();
    await lc.service.disableBot(lc.bot.botUserId);
    const { code, ms } = await closeLatency(ws, startedAt, 6000);
    expect(code).toBe(1008);
    expect(ms).toBeLessThan(1000);
  });
});
