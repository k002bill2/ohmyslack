import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOG_CANARIES } from '../../../../tools/log-canaries.js';
import { createBotEvents, createBotService } from '../../src/modules/bots/index.js';
import { meResponseSchema } from '../../src/shared.js';
import { authed, login, sessionCookie } from '../support/auth-app.js';
import { dumpAllRows } from './bootstrap-harness.js';
import { setupAuthInt, teardownAuthInt, type AuthIntContext } from './auth-int-harness.js';

/** 정본: DEV_DESIGN 6-3 TR-SEC-02, TRD §5. 초대 표식은 W-06b 전이라 invites에 합성 hash 행을 직접 넣는다. */
const SECRET = `${LOG_CANARIES.credential ?? ''}-pw`;
const INVITE = LOG_CANARIES.invite ?? '';
const EMAIL = 'member@example.test';
let ctx: AuthIntContext | undefined;

beforeEach(async () => {
  ctx = await setupAuthInt(EMAIL, SECRET);
});

afterEach(async () => {
  await teardownAuthInt(ctx);
  ctx = undefined;
});

describe('TR-SEC-02 secret storage', () => {
  it('TR-SEC-02 비밀번호·세션·초대 표식 원문이 DB 모든 컬럼과 로그에 0건이다', async () => {
    const c = ctx as AuthIntContext;
    expect((await login(c.app, EMAIL, `${SECRET}-wrong`)).statusCode).toBe(401);
    const res = await login(c.app, EMAIL, SECRET);
    expect(res.statusCode).toBe(200);
    const token = sessionCookie(res) ?? '';
    const csrf = meResponseSchema.parse(res.json()).csrf_token;
    expect(token.length).toBeGreaterThanOrEqual(43);
    await c.schema.pool.query(
      "INSERT INTO invites (id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, now() + interval '72 hours')",
      [randomUUID(), createHash('sha256').update(INVITE).digest('hex'), c.userId],
    );
    expect((await authed(c.app, 'GET', '/api/me', token)).statusCode).toBe(200);
    // 봇 토큰 원문(TRD §5-2 2항, W-18): 발급·검증 후에도 DB·로그에 원문 0건.
    const workspaceId = randomUUID();
    await c.schema.pool.query("INSERT INTO workspaces (id, name, created_at) VALUES ($1, 'WS', now())", [workspaceId]);
    await c.schema.pool.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [workspaceId, c.userId]);
    const bots = createBotService({ pool: c.schema.pool, events: createBotEvents() });
    const bot = await bots.createBot({ displayName: 'Jarvis', slug: 'jarvis' });
    const botToken = (await bots.issueToken(bot.botUserId, 'adapter')).token;
    expect(await bots.verifyToken(botToken)).toBeDefined();
    expect((await c.app.inject({ method: 'GET', url: '/api/me', headers: { host: 'ohmy.test', authorization: `Bearer ${botToken}` } })).statusCode).toBe(401);

    const dump = await dumpAllRows(c.schema.pool);
    const logs = c.logs.join('\n');
    for (const marker of [SECRET, token, csrf, INVITE, botToken]) {
      expect(dump).not.toContain(marker);
      expect(logs).not.toContain(marker);
    }
    expect(dump).toContain(createHash('sha256').update(token).digest('hex'));
    expect(dump).toContain(createHash('sha256').update(botToken).digest('hex'));
    expect(logs).not.toContain(EMAIL);
    expect(c.logs.length).toBeGreaterThanOrEqual(3);
  });
});
