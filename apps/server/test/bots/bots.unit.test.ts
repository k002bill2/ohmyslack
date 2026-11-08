import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createBotEvents, createBotService, runBotAdmin, type BotConnectionsCloseEvent } from '../../src/modules/bots/index.js';
import { pipedIo } from '../auth/bootstrap-harness.js';

/**
 * bots 서비스·CLI 분기 단위 테스트(실DB 동작·경쟁은 bot-*.int.test.ts). 저장소 SQL을 문장 단위로 흉내 내는 메모리 풀을 쓴다.
 * 토큰 원문은 저장소에 넘어오지 않아야 하므로, 풀이 받은 모든 파라미터에 원문이 없는지도 본다.
 */
interface TokenRow {
  id: string;
  bot_user_id: string;
  token_hash: string;
  revoked_at: Date | null;
  last_used_at: Date | null;
}
interface UserRow {
  id: string;
  email_norm: string;
  display_name: string;
  status: 'active' | 'disabled';
}

const OWNER = '00000000-0000-4000-8000-000000000001';
const WORKSPACE = '00000000-0000-4000-8000-0000000000aa';

function fakePool(): { pool: pg.Pool; params: unknown[][] } {
  const bots = new Map<string, UserRow>();
  const tokens: TokenRow[] = [];
  const params: unknown[][] = [];
  const res = (rows: unknown[]): { rows: unknown[]; rowCount: number } => ({ rows, rowCount: rows.length });
  const live = (bot: string): TokenRow[] => tokens.filter((t) => t.bot_user_id === bot && t.revoked_at === null);
  const query = async (sql: string, p: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    params.push(p);
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return res([]);
    if (sql.includes('FROM workspaces')) return res([{ id: WORKSPACE }]);
    if (sql.includes("wm.role = 'owner'")) return res([{ user_id: OWNER }]);
    if (sql.startsWith('SELECT 1 FROM users WHERE email_norm')) return res([...bots.values()].filter((u) => u.email_norm === p[0]));
    if (sql.startsWith('INSERT INTO users')) {
      bots.set(p[0] as string, { id: p[0] as string, email_norm: p[1] as string, display_name: p[2] as string, status: 'active' });
      return res([]);
    }
    if (sql.includes('last_seq::text')) return res([{ last_seq: '0' }]);
    if (sql.startsWith('INSERT INTO')) return res([]);
    if (sql.startsWith('SELECT status FROM users')) return res(bots.has(p[0] as string) ? [{ status: bots.get(p[0] as string)?.status }] : []);
    if (sql.startsWith('SELECT id FROM bot_tokens')) return res(live(p[0] as string).map((t) => ({ id: t.id })));
    if (sql.startsWith('UPDATE bot_tokens SET revoked_at = $2 WHERE id')) {
      const t = tokens.find((x) => x.id === p[0] && x.revoked_at === null);
      if (t !== undefined) t.revoked_at = p[1] as Date;
      return res(t === undefined ? [] : [{ bot_user_id: t.bot_user_id }]);
    }
    if (sql.startsWith('SELECT 1 FROM bot_tokens')) return res(tokens.filter((t) => t.id === p[0]));
    if (sql.startsWith("UPDATE users SET status = 'disabled'")) {
      const u = bots.get(p[0] as string);
      if (u !== undefined) u.status = 'disabled';
      return res([]);
    }
    if (sql.startsWith('UPDATE bot_tokens SET revoked_at = $2 WHERE bot_user_id')) {
      const hit = live(p[0] as string);
      for (const t of hit) t.revoked_at = p[1] as Date;
      return res(hit.map((t) => ({ id: t.id })));
    }
    if (sql.includes("FROM users u WHERE u.kind = 'bot'")) {
      return res([...bots.values()].map((u) => ({ ...u, live: live(u.id).length })));
    }
    if (sql.startsWith('SELECT id FROM users WHERE email_norm')) return res([...bots.values()].filter((u) => u.email_norm === p[0]));
    if (sql.includes('SET last_used_at')) {
      const t = tokens.find((x) => x.token_hash === p[0] && x.revoked_at === null && bots.get(x.bot_user_id)?.status === 'active');
      if (t !== undefined) t.last_used_at = p[1] as Date;
      return res(t === undefined ? [] : [{ id: t.id, bot_user_id: t.bot_user_id }]);
    }
    throw new Error(`fake pool: 처리하지 않는 SQL ${sql.slice(0, 40)}`);
  };
  const insertToken = async (sql: string, p: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    if (sql.startsWith('INSERT INTO bot_tokens')) {
      params.push(p);
      tokens.push({ id: p[0] as string, bot_user_id: p[1] as string, token_hash: p[2] as string, revoked_at: null, last_used_at: null });
      return res([]);
    }
    return query(sql, p);
  };
  const client = { query: insertToken, release: () => undefined };
  const pool = { query: insertToken, connect: async () => client } as unknown as pg.Pool;
  return { pool, params };
}

function setup(): { run: (argv: string[]) => Promise<{ code: number; out: string; err: string }>; closed: BotConnectionsCloseEvent[]; params: unknown[][] } {
  const { pool, params } = fakePool();
  const events = createBotEvents();
  const closed: BotConnectionsCloseEvent[] = [];
  events.onConnectionsClose((e) => closed.push(e));
  const service = createBotService({ pool, events, clock: () => Date.UTC(2026, 10, 8) });
  const run = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
    const io = pipedIo('');
    const code = await runBotAdmin(argv, io, service);
    return { code, out: io.out(), err: io.err() };
  };
  return { run, closed, params };
}

const lastLine = (text: string): string => text.trimEnd().split('\n').at(-1) ?? '';

describe('bot-admin CLI 분기(메모리 풀)', () => {
  it('create → issue → rotate → 상한 거부 → revoke → disable → list 흐름과 종료 코드', async () => {
    const { run, closed, params } = setup();
    expect((await run(['create', '--name', 'Jarvis Bot'])).code).toBe(0);
    const issued = await run(['token', 'issue', '--bot', 'jarvis-bot']);
    expect(issued.code).toBe(0);
    const first = lastLine(issued.out);
    expect(first).toMatch(/^omsb_[A-Za-z0-9_-]{43}$/);
    const rotated = await run(['token', 'rotate', '--bot', 'jarvis-bot']);
    expect(rotated.code).toBe(0);
    const second = lastLine(rotated.out);
    expect(second).not.toBe(first);
    const limited = await run(['token', 'issue', '--bot', 'jarvis-bot', '--label', 'x']);
    expect(limited.code).toBe(1);
    expect(limited.err).toContain('token_limit');
    expect(JSON.stringify(params).includes(first) || JSON.stringify(params).includes(second)).toBe(false);

    const oldId = /옛 토큰\(([0-9a-f-]{36})\)/.exec(rotated.out)?.[1] ?? '';
    expect((await run(['token', 'revoke', '--id', oldId])).out).toContain('폐기했습니다');
    expect((await run(['token', 'revoke', '--id', oldId])).out).toContain('이미 폐기된');
    expect(closed).toEqual([{ botUserId: expect.any(String), tokenIds: [oldId] }]);

    const disabled = await run(['disable', '--bot', 'jarvis-bot']);
    expect(disabled.out).toContain('토큰 1개를 폐기');
    expect(closed).toHaveLength(2);
    const listed = await run(['list']);
    expect(listed.out).toContain('jarvis-bot\tdisabled\t미폐기 토큰 0개');
    expect(listed.out.includes(first) || listed.out.includes(second)).toBe(false);
  });

  it('사용법 오류는 종료 2, 없는 봇·토큰은 종료 1이고 입력을 되풀이하지 않는다', async () => {
    const { run } = setup();
    for (const argv of [[], ['omsb_fixture-1'], ['token'], ['create'], ['token', 'revoke'], ['list', '--x', 'y'], ['token', 'issue']]) {
      const r = await run(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err.includes('omsb_fixture-1')).toBe(false);
    }
    expect((await run(['token', 'revoke', '--id', 'not-a-uuid'])).code).toBe(2);
    expect((await run(['token', 'revoke', '--id', '00000000-0000-4000-8000-00000000dead'])).code).toBe(1);
    expect((await run(['disable', '--bot', 'nobody'])).code).toBe(1);
    expect((await run(['create', '--name', '한글만'])).code).toBe(2);
    expect((await run(['create', '--name', 'Jarvis', '--slug', 'Bad Slug'])).code).toBe(2);
  });

  it('verifyToken: 형식이 틀리면 저장소를 조회하지 않고, 폐기·비활성 뒤에는 undefined', async () => {
    const { pool, params } = fakePool();
    const service = createBotService({ pool, events: createBotEvents() });
    const bot = await service.createBot({ displayName: 'Jarvis' });
    const before = params.length;
    expect(await service.verifyToken('omsb_fixture-1')).toBeUndefined();
    expect(await service.verifyToken('not-a-token')).toBeUndefined();
    expect(params.length).toBe(before);
    const issued = await service.issueToken(bot.botUserId, 'adapter');
    expect(await service.verifyToken(issued.token)).toEqual({ botUserId: bot.botUserId, tokenId: issued.tokenId });
    await service.disableBot(bot.botUserId);
    expect(await service.verifyToken(issued.token)).toBeUndefined();
    await expect(service.issueToken(bot.botUserId, 'again')).rejects.toMatchObject({ code: 'bot_disabled' });
    await expect(service.issueToken(bot.botUserId, '   ')).rejects.toMatchObject({ code: 'invalid_label' });
  });

  it('close 훅 구독 해제 뒤에는 호출되지 않고 이벤트는 동결돼 있다', () => {
    const events = createBotEvents();
    const seen: BotConnectionsCloseEvent[] = [];
    const off = events.onConnectionsClose((e) => seen.push(e));
    events.connectionsClose({ botUserId: 'b', tokenIds: ['t'] });
    off();
    events.connectionsClose({ botUserId: 'b', tokenIds: ['u'] });
    expect(seen).toHaveLength(1);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(seen[0]?.tokenIds)).toBe(true);
  });
});
