import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../../src/modules/auth/password.js';
import { hashToken } from '../../src/modules/auth/service.js';
import type { UserRecord } from '../../src/modules/auth/store.js';
import { authed, createMemoryAuthStore, login, sessionCookie, testApp, type MemoryAuthStore } from '../support/auth-app.js';

/**
 * 봇 계정 로그인·세션 경계(TRD §5-2 1항)의 kind 분기를 직접 관찰한다. 정상 봇 행은 해시가 NULL이라 해시 검증만으로도
 * 실패하므로, kind 분기가 실제로 막는지 보려면 DB CHECK를 우회한 "해시가 있는 봇" 레코드가 필요하다(메모리 저장소).
 */
const BOT_ID = '22222222-2222-4222-8222-222222222222';
const PHRASE = randomBytes(18).toString('base64url');
let hash: string;
let app: FastifyInstance | undefined;
let store: MemoryAuthStore;

beforeAll(async () => {
  hash = await hashPassword(PHRASE);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function setup(record: UserRecord): FastifyInstance {
  store = createMemoryAuthStore();
  store.users.set(record.id, record);
  app = testApp({ authStore: store, clock: () => Date.UTC(2026, 10, 8) });
  return app;
}

const BOT_BASE = { id: BOT_ID, emailNorm: 'jarvis@bot.invalid', displayName: 'Jarvis', status: 'active', role: 'member' } as const;

/** 불변식 위반(봇인데 해시 있음)을 일부러 만든다: kind 분기 없이 해시만 보면 로그인이 성공해 버린다. */
function corruptBot(): UserRecord {
  return { ...BOT_BASE, kind: 'bot', passwordHash: hash } as unknown as UserRecord;
}

describe('봇 kind 분기(로그인·세션)', () => {
  it('해시가 맞는 봇 레코드라도 로그인은 invalid_credentials 401이고 세션·쿠키가 생기지 않는다', async () => {
    const res = await login(setup(corruptBot()), 'jarvis@bot.invalid', PHRASE);
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_credentials');
    expect(sessionCookie(res)).toBeUndefined();
    expect(store.sessions.size).toBe(0);
  });

  it('봇 사용자에 걸린 세션 행이 있어도 메인 리스너 인증(peek)은 401이다', async () => {
    const a = setup({ ...BOT_BASE, kind: 'bot', passwordHash: null });
    const at = new Date(Date.UTC(2026, 10, 8));
    store.sessions.set('s1', {
      id: 's1',
      userId: BOT_ID,
      tokenHash: hashToken('fixture-sess'),
      createdAt: at,
      lastSeenAt: at,
      expiresAt: new Date(at.getTime() + 60_000),
      revokedAt: null,
    });
    expect((await authed(a, 'GET', '/api/me', 'fixture-sess')).statusCode).toBe(401);
  });
});
