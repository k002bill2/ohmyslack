import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBotAdmin } from '../../src/modules/bots/index.js';
import { dumpAllRows, pipedIo, type CapturedIo } from '../auth/bootstrap-harness.js';
import { botFixture, type BotFixture } from './bot-harness.js';
import { setupConvInt, teardownConvInt } from '../conversations/conv-int-harness.js';

/** 봇 관리 로컬 명령(정본: TRD §5-2 1·2·5항, ADR-001). 원격 생성 경로 부재 단언은 통합 레인 범위. */
let fx: BotFixture;

beforeEach(async () => {
  fx = await botFixture();
});

afterEach(async () => {
  await fx.schema.drop();
});

async function run(...argv: string[]): Promise<{ code: number; io: CapturedIo }> {
  const io = pipedIo('');
  const code = await runBotAdmin(argv, io, fx.service);
  return { code, io };
}

/** issue·rotate 출력의 마지막 줄이 원문이다. */
function tokenFrom(io: CapturedIo): string {
  const match = io.out().match(/omsb_[A-Za-z0-9_-]{43}/g) ?? [];
  expect(match).toHaveLength(1);
  return match[0] ?? '';
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('bot-admin create', () => {
  it('kind=bot·password_hash NULL·<slug>@bot.invalid·role member 봇과 owner DM을 만든다', async () => {
    const { code, io } = await run('create', '--name', 'Jarvis Bot');
    expect(code).toBe(0);
    expect(io.err()).toBe('');
    const bot = await fx.schema.pool.query<{ id: string; kind: string; password_hash: string | null; email_norm: string; status: string }>(
      "SELECT id, kind, password_hash, email_norm, status FROM users WHERE kind = 'bot'",
    );
    expect(bot.rows).toHaveLength(1);
    const row = bot.rows[0];
    expect(row).toMatchObject({ kind: 'bot', password_hash: null, email_norm: 'jarvis-bot@bot.invalid', status: 'active' });
    const role = await fx.schema.pool.query<{ role: string }>('SELECT role FROM workspace_members WHERE user_id = $1', [row?.id]);
    expect(role.rows.map((r) => r.role)).toEqual(['member']);
    const dm = await fx.schema.pool.query<{ id: string; normalized_pair_key: string }>(
      "SELECT id, normalized_pair_key FROM conversations WHERE kind = 'dm'",
    );
    expect(dm.rows).toHaveLength(1);
    expect(dm.rows[0]?.normalized_pair_key).toBe([fx.ownerId, row?.id ?? ''].sort().join(':'));
    const members = await fx.schema.pool.query<{ user_id: string }>(
      'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL ORDER BY user_id',
      [dm.rows[0]?.id],
    );
    expect(members.rows.map((m) => m.user_id)).toEqual([fx.ownerId, row?.id ?? ''].sort());
  });

  it('--slug를 쓰면 그 slug를 쓰고, 같은 slug 재생성은 거부(종료 1)된다', async () => {
    expect((await run('create', '--name', '자비스', '--slug', 'jarvis')).code).toBe(0);
    const again = await run('create', '--name', 'Other', '--slug', 'jarvis');
    expect(again.code).toBe(1);
    expect(again.io.err()).toContain('slug_taken');
  });

  it('ASCII가 없는 이름은 slug 유도 실패로 종료 2, 잘못된 --slug도 종료 2', async () => {
    expect((await run('create', '--name', '자비스')).code).toBe(2);
    expect((await run('create', '--name', 'Jarvis', '--slug', '-bad')).code).toBe(2);
    expect((await run('create', '--name', 'Jarvis', '--slug', 'UPPER')).code).toBe(2);
    const users = await fx.schema.pool.query("SELECT 1 FROM users WHERE kind = 'bot'");
    expect(users.rowCount).toBe(0);
  });
});

describe('bot-admin token', () => {
  it('issue 원문은 stdout에 정확히 1회만 나오고 stderr·DB 어디에도 없다', async () => {
    expect((await run('create', '--name', 'Jarvis')).code).toBe(0);
    const issued = await run('token', 'issue', '--bot', 'jarvis', '--label', 'adapter');
    expect(issued.code).toBe(0);
    const raw = tokenFrom(issued.io);
    expect(occurrences(issued.io.out(), raw)).toBe(1);
    expect(issued.io.err()).toBe('');
    expect((await dumpAllRows(fx.schema.pool)).includes(raw)).toBe(false);
    const listed = await run('list');
    expect(listed.io.out().includes(raw)).toBe(false);
    expect(await fx.service.verifyToken(raw)).toBeDefined();
  });

  it('rotate는 새 원문 1회와 옛 토큰 id를 출력하고, revoke --id로 옛 토큰을 폐기한다', async () => {
    await run('create', '--name', 'Jarvis');
    const first = await run('token', 'issue', '--bot', 'jarvis');
    const oldRaw = tokenFrom(first.io);
    const oldId = (await fx.service.verifyToken(oldRaw))?.tokenId ?? '';
    const rotated = await run('token', 'rotate', '--bot', 'jarvis');
    expect(rotated.code).toBe(0);
    const newRaw = tokenFrom(rotated.io);
    expect(rotated.io.out()).toContain(oldId);
    expect(rotated.io.out().includes(oldRaw)).toBe(false);
    expect((await run('token', 'revoke', '--id', oldId)).code).toBe(0);
    expect(await fx.service.verifyToken(oldRaw)).toBeUndefined();
    expect(await fx.service.verifyToken(newRaw)).toBeDefined();
    expect(fx.closed).toEqual([{ botUserId: expect.any(String), tokenIds: [oldId] }]);
  });

  it('세 번째 미폐기 토큰 발급은 token_limit으로 거부(종료 1)되고 원문을 출력하지 않는다', async () => {
    await run('create', '--name', 'Jarvis');
    await run('token', 'issue', '--bot', 'jarvis');
    await run('token', 'issue', '--bot', 'jarvis');
    const third = await run('token', 'issue', '--bot', 'jarvis');
    expect(third.code).toBe(1);
    expect(third.io.err()).toContain('token_limit');
    expect(third.io.out()).not.toMatch(/omsb_/);
  });
});

describe('bot-admin disable·list', () => {
  it('disable은 봇을 비활성화하고 토큰을 폐기하며, list는 해시 없이 상태·개수만 보인다', async () => {
    await run('create', '--name', 'Jarvis');
    const raw = tokenFrom((await run('token', 'issue', '--bot', 'jarvis')).io);
    expect((await run('disable', '--bot', 'jarvis')).code).toBe(0);
    expect(await fx.service.verifyToken(raw)).toBeUndefined();
    const listed = await run('list');
    expect(listed.code).toBe(0);
    expect(listed.io.out()).toContain('jarvis\tdisabled\t미폐기 토큰 0개');
    const hashes = await fx.schema.pool.query<{ token_hash: string }>('SELECT token_hash FROM bot_tokens');
    for (const { token_hash: hash } of hashes.rows) expect(listed.io.out().includes(hash)).toBe(false);
  });
});

describe('bot-admin 사용법 오류', () => {
  it('알 수 없는 명령·누락 옵션·여분 인자·형식이 틀린 id는 종료 2이고 입력을 되풀이하지 않는다', async () => {
    const fixtureLike = 'omsb_fixture-1';
    const cases: string[][] = [
      [],
      [fixtureLike],
      ['token'],
      ['token', 'issue'],
      ['token', 'revoke'],
      ['token', 'revoke', '--id', fixtureLike],
      ['create'],
      ['list', '--bot', fixtureLike],
      ['disable', '--bot', 'jarvis', 'extra'],
    ];
    for (const argv of cases) {
      const { code, io } = await run(...argv);
      expect(code, argv.join(' ')).toBe(2);
      expect(io.err().includes(fixtureLike)).toBe(false);
      expect(io.out()).toBe('');
    }
  });

  it('없는 봇은 no_such_bot으로 종료 1', async () => {
    const { code, io } = await run('token', 'issue', '--bot', 'ghost');
    expect(code).toBe(1);
    expect(io.err()).toContain('no_such_bot');
  });
});

describe('원격 생성 경로 없음(TRD §5-2 1항)', () => {
  it('모든 저장소를 붙인 메인 앱의 레지스트리에 봇 경로·bot 메타 라우트가 0개다', async () => {
    const ctx = await setupConvInt();
    try {
      const routes = ctx.app.accessRoutes;
      expect(routes.length).toBeGreaterThan(10);
      // 예외는 채널 멤버십 추가·제거 2개뿐(BOT_CHANNEL_SPEC §4-1, conversation 메타). 봇 생성·토큰 경로는 0.
      const membership = new Set(['POST /api/conversations/:id/bots', 'DELETE /api/conversations/:id/bots/:bot_user_id']);
      const botRoutes = routes.filter((r) => /bot/i.test(r.url) || r.access === 'bot');
      expect(botRoutes.filter((r) => !membership.has(`${r.method} ${r.url}`))).toEqual([]);
      expect(botRoutes.every((r) => r.access === 'conversation')).toBe(true);
    } finally {
      await teardownConvInt(ctx);
    }
  });
});
