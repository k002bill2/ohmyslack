import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliRefusal } from '../../bin/lib/cli.js';
import { BOT_TOKEN_PREFIX } from '../../src/modules/bots/index.js';
import { LOG_CANARIES } from '../../../../tools/log-canaries.js';
import { createPgAuthStore } from '../../src/modules/auth/index.js';
import { createOpsLogger } from '../../src/modules/ops/logger.js';
import { dumpAllRows } from '../auth/bootstrap-harness.js';
import { HOST, testApp } from '../support/auth-app.js';
import { botFixture, type BotFixture } from './bot-harness.js';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { as } from '../conversations/conv-int-harness.js';
import { bot, count, http, main, setupBotListener, teardownBotListener, type BotListenerContext } from './bot-listener-harness.js';

/** 봇 토큰 저장·검증·폐기·회전·비활성화·발급 상한(정본: TRD §5-2 2항, ADR-001). WS close 연결은 다음 레인 범위. */
let fx: BotFixture;
let botId: string;

const sha256 = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex');

beforeEach(async () => {
  fx = await botFixture();
  botId = (await fx.service.createBot({ displayName: 'Jarvis' })).botUserId;
});

afterEach(async () => {
  await fx.schema.drop();
});

describe('봇 토큰 저장 형식', () => {
  it('원문은 omsb_ + base64url 43자이고 DB에는 SHA-256 hex만 남는다', async () => {
    const issued = await fx.service.issueToken(botId, 'adapter');
    expect(issued.token.startsWith(BOT_TOKEN_PREFIX)).toBe(true);
    expect(issued.token).toMatch(/^omsb_[A-Za-z0-9_-]{43}$/);
    const row = await fx.schema.pool.query<{ token_hash: string }>('SELECT token_hash FROM bot_tokens WHERE id = $1', [issued.tokenId]);
    expect(row.rows[0]?.token_hash).toBe(sha256(issued.token));
    const dump = await dumpAllRows(fx.schema.pool);
    expect(dump.includes(issued.token)).toBe(false);
    expect(dump.includes(issued.token.slice(BOT_TOKEN_PREFIX.length))).toBe(false);
  });
});

describe('봇 토큰 검증', () => {
  it('유효 토큰은 봇·토큰 id를 돌려주고 last_used_at을 기록한다', async () => {
    const issued = await fx.service.issueToken(botId, 'adapter');
    fx.now = Date.parse('2026-11-08T01:02:03Z');
    expect(await fx.service.verifyToken(issued.token)).toEqual({ botUserId: botId, tokenId: issued.tokenId });
    const row = await fx.schema.pool.query<{ last_used_at: Date }>('SELECT last_used_at FROM bot_tokens WHERE id = $1', [issued.tokenId]);
    expect(row.rows[0]?.last_used_at.toISOString()).toBe('2026-11-08T01:02:03.000Z');
  });

  it('접두사 없는 값·형식만 맞는 미등록 값·짧은 값은 undefined', async () => {
    const issued = await fx.service.issueToken(botId, 'adapter');
    const fixtureUnknown = `omsb_${'A'.repeat(43)}`;
    expect(await fx.service.verifyToken(issued.token.slice(BOT_TOKEN_PREFIX.length))).toBeUndefined();
    expect(await fx.service.verifyToken(`omsx_${issued.token.slice(5)}`)).toBeUndefined();
    expect(await fx.service.verifyToken(fixtureUnknown)).toBeUndefined();
    expect(await fx.service.verifyToken('omsb_fixture-1')).toBeUndefined();
    expect(await fx.service.verifyToken('')).toBeUndefined();
  });

  it('폐기 뒤에는 undefined이고 연결 닫기 훅이 그 토큰 id로 호출된다(재폐기는 멱등)', async () => {
    const issued = await fx.service.issueToken(botId, 'adapter');
    expect(await fx.service.revokeToken(issued.tokenId)).toEqual({ revoked: true });
    expect(await fx.service.verifyToken(issued.token)).toBeUndefined();
    expect(fx.closed).toEqual([{ botUserId: botId, tokenIds: [issued.tokenId] }]);
    expect(await fx.service.revokeToken(issued.tokenId)).toEqual({ revoked: false });
    expect(fx.closed).toHaveLength(1);
  });
});

describe('봇 토큰 회전', () => {
  it('회전 뒤 옛·새 토큰이 모두 유효하고, 옛 토큰을 폐기하면 새 토큰만 유효하다', async () => {
    const old = await fx.service.issueToken(botId, 'adapter');
    const rotated = await fx.service.rotateToken(botId);
    expect(rotated.previousTokenIds).toEqual([old.tokenId]);
    expect(await fx.service.verifyToken(old.token)).toEqual({ botUserId: botId, tokenId: old.tokenId });
    expect(await fx.service.verifyToken(rotated.token)).toEqual({ botUserId: botId, tokenId: rotated.tokenId });
    await fx.service.revokeToken(old.tokenId);
    expect(await fx.service.verifyToken(old.token)).toBeUndefined();
    expect(await fx.service.verifyToken(rotated.token)).toEqual({ botUserId: botId, tokenId: rotated.tokenId });
  });

  it('미폐기 2개면 회전도 token_limit으로 거부한다', async () => {
    await fx.service.issueToken(botId, 'a');
    await fx.service.issueToken(botId, 'b');
    await expect(fx.service.rotateToken(botId)).rejects.toMatchObject({ code: 'token_limit' });
  });
});

describe('봇 비활성화', () => {
  it('비활성화하면 모든 토큰이 undefined가 되고 폐기된 토큰 id 전부로 훅이 호출된다', async () => {
    const a = await fx.service.issueToken(botId, 'a');
    const b = await fx.service.issueToken(botId, 'b');
    const result = await fx.service.disableBot(botId);
    expect([...result.revokedTokenIds].sort()).toEqual([a.tokenId, b.tokenId].sort());
    expect(await fx.service.verifyToken(a.token)).toBeUndefined();
    expect(await fx.service.verifyToken(b.token)).toBeUndefined();
    expect(fx.closed).toHaveLength(1);
    expect(fx.closed[0]?.botUserId).toBe(botId);
    expect([...(fx.closed[0]?.tokenIds ?? [])].sort()).toEqual([a.tokenId, b.tokenId].sort());
    await expect(fx.service.issueToken(botId, 'c')).rejects.toMatchObject({ code: 'bot_disabled' });
  });

  it('토큰은 살아 있어도 봇 status가 disabled면 검증이 거부된다', async () => {
    const issued = await fx.service.issueToken(botId, 'a');
    await fx.schema.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [botId]);
    expect(await fx.service.verifyToken(issued.token)).toBeUndefined();
  });
});

describe('발급 상한(봇당 미폐기 2개)', () => {
  it('동시 발급 10건 중 정확히 2건만 성공하고 8건은 token_limit으로 거부된다', async () => {
    // 풀 연결을 미리 열어 둔다: 연결 수립 지연이 트랜잭션을 우연히 직렬화하면 잠금 누락을 잡지 못한다.
    const warm = await Promise.all(Array.from({ length: 4 }, () => fx.schema.pool.connect()));
    for (const client of warm) client.release();
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => fx.service.issueToken(botId, `c${i}`)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected' && r.reason instanceof CliRefusal && r.reason.code === 'token_limit',
    );
    expect(ok).toHaveLength(2);
    expect(refused).toHaveLength(8);
    const live = await fx.schema.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM bot_tokens WHERE bot_user_id = $1 AND revoked_at IS NULL',
      [botId],
    );
    expect(live.rows[0]?.n).toBe(2);
  });

  it('하나를 폐기하면 다시 발급할 수 있다', async () => {
    const a = await fx.service.issueToken(botId, 'a');
    await fx.service.issueToken(botId, 'b');
    await fx.service.revokeToken(a.tokenId);
    await expect(fx.service.issueToken(botId, 'c')).resolves.toMatchObject({ tokenId: expect.any(String) });
  });

  it('사람 계정 id로는 발급할 수 없다', async () => {
    await expect(fx.service.issueToken(fx.ownerId, 'a')).rejects.toMatchObject({ code: 'no_such_bot' });
  });
});

describe('메인 리스너는 Authorization 헤더로 인증하지 않는다(TRD §5-2 3항, B9)', () => {
  it('유효한 봇 토큰·봇 토큰 카나리아를 Bearer로 보내도 사람 API는 401이고 로그에 원문이 남지 않는다', async () => {
    const issued = await fx.service.issueToken(botId, 'adapter');
    const canary = LOG_CANARIES.bot ?? '';
    expect(canary.startsWith(BOT_TOKEN_PREFIX)).toBe(true);
    const logs: string[] = [];
    const app = testApp({
      authStore: createPgAuthStore(fx.schema.pool),
      // stdout에도 써서 check:log-leak(int 로그 스캔)이 봇 토큰 카나리아를 실제로 검사하게 한다.
      logger: { log: (fields) => (createOpsLogger().log(fields), createOpsLogger((line) => logs.push(line)).log(fields)) },
    });
    try {
      for (const bearer of [issued.token, canary]) {
        for (const url of ['/api/me', '/api/sessions']) {
          const res = await app.inject({ method: 'GET', url, headers: { host: HOST, authorization: `Bearer ${bearer}` } });
          expect(res.statusCode, `${url}`).toBe(401);
          expect(res.body.includes(bearer)).toBe(false);
        }
      }
      const joined = logs.join('\n');
      expect(logs.length).toBeGreaterThan(0);
      expect(joined.includes(issued.token)).toBe(false);
      expect(joined.includes(canary)).toBe(false);
      // 메인 리스너 요청은 봇 토큰 사용으로 기록되지 않는다(verifyToken 미호출).
      const used = await fx.schema.pool.query('SELECT last_used_at FROM bot_tokens WHERE id = $1', [issued.tokenId]);
      expect(used.rows[0]?.last_used_at).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe('봇 토큰 경계(실제 두 리스너 HTTP)', () => {
  let lc: BotListenerContext;

  beforeEach(async () => {
    lc = await setupBotListener();
  });

  afterEach(async () => {
    await teardownBotListener(lc);
  });

  it('FR-BOT-02 봇 토큰은 해시로만 저장되고 폐기·회전 후 옛 토큰은 401이며 봇 토큰으로 사람 API와 사람 쿠키로 봇 API를 호출하면 401이고 Origin·Cookie가 붙은 봇 요청은 거부된다', async () => {
    const pool = lc.conv.schema.pool;
    // 해시로만 저장
    const row = await pool.query<{ token_hash: string }>('SELECT token_hash FROM bot_tokens WHERE id = $1', [lc.tokenId]);
    expect(row.rows[0]?.token_hash).toBe(sha256(lc.token));
    expect((await dumpAllRows(pool)).includes(lc.token)).toBe(false);
    expect((await bot(lc, 'GET', 'me')).status).toBe(200);

    // 회전 → 새 토큰 200, 옛 토큰 폐기 후 401(형식 오류·미등록과 같은 본문)
    const rotated = await lc.service.rotateToken(lc.bot.botUserId);
    expect((await bot(lc, 'GET', 'me', undefined, rotated.token)).status).toBe(200);
    await lc.service.revokeToken(lc.tokenId);
    const old = await bot(lc, 'GET', 'me');
    const malformed = await bot(lc, 'GET', 'me', undefined, 'omsb_fixture-malformed');
    expect(old.status).toBe(401);
    expect(malformed.status).toBe(401);
    expect(old.json.error.code).toBe(malformed.json.error.code);
    expect(Object.keys(old.json.error).sort()).toEqual(Object.keys(malformed.json.error).sort());

    // 봇 토큰으로 사람 API(Bearer·쿠키 모두) → 401. 메인 리스너는 Authorization을 인증에 쓰지 않는다.
    const viaBearer = await main(lc, 'GET', '/api/me', { authorization: `Bearer ${rotated.token}` });
    expect(viaBearer.status).toBe(401);
    const viaCookie = await main(lc, 'GET', '/api/me', { cookie: `${SESSION_COOKIE}=${rotated.token}` });
    expect(viaCookie.status).toBe(401);
    expect((await main(lc, 'GET', '/api/sync?after=0', { authorization: `Bearer ${rotated.token}` })).status).toBe(401);

    // 사람 세션 토큰으로 봇 API: Bearer로 보내면 401, Cookie 헤더로 보내면 브라우저발 요청으로 400(§5-2 4항)
    const human = await as(lc.conv.app, 'a');
    expect((await bot(lc, 'GET', 'me', undefined, human.token)).status).toBe(401);
    const humanCookie = await http(lc.botPort, 'GET', '/api/bot/v1/me', { cookie: `${SESSION_COOKIE}=${human.token}` });
    expect(humanCookie.status).toBe(400);

    // 유효 봇 토큰이어도 Origin·Cookie가 붙으면 400, 저장 0
    const auth = { authorization: `Bearer ${rotated.token}` };
    const before = await count(lc, 'SELECT count(*)::int AS n FROM messages', []);
    const post = (headers: Record<string, string>) =>
      http(lc.botPort, 'POST', `/api/bot/v1/conversations/${lc.bot.dmConversationId}/messages`, { ...auth, ...headers }, {
        client_message_id: randomUUID(),
        body: 'x',
      });
    expect((await post({ origin: `http://127.0.0.1:${lc.botPort}` })).status).toBe(400);
    expect((await post({ cookie: 'a=b' })).status).toBe(400);
    expect(await count(lc, 'SELECT count(*)::int AS n FROM messages', [])).toBe(before);
    expect((await post({})).status).toBe(201);

    // 봇 비활성화 → 남은 토큰도 같은 401
    await lc.service.disableBot(lc.bot.botUserId);
    const disabled = await bot(lc, 'GET', 'me', undefined, rotated.token);
    expect(disabled.status).toBe(401);
    expect(disabled.json.error.code).toBe(malformed.json.error.code);
  });
});
