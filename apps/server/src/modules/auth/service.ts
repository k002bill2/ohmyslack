import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthEvents } from './events.js';
import type { LoginLimiter } from './login-limiter.js';
import { hashPassword, normalizeEmail, verifyPassword } from './password.js';
import type { AuthStore, SessionRecord, UserRecord } from './store.js';

/** 세션 수명(정본: TRD §5 30일 sliding, §5-1 S8 절대 90일). */
export const SESSION_SLIDING_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 세션 결속 CSRF 토큰: 세션 원문 토큰에서만 유도되므로 쿠키 없이는 만들 수 없다. DB에 저장하지 않는다. */
export function csrfTokenFor(sessionToken: string): string {
  return createHash('sha256').update(`csrf:${sessionToken}`, 'utf8').digest('base64url');
}

export function csrfMatches(sessionToken: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const expected = Buffer.from(csrfTokenFor(sessionToken));
  const given = Buffer.from(presented);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function slidingExpiry(createdAt: Date, now: Date): Date {
  return new Date(Math.min(now.getTime() + SESSION_SLIDING_MS, createdAt.getTime() + SESSION_ABSOLUTE_MS));
}

export interface Authenticated {
  readonly user: UserRecord;
  readonly session: SessionRecord;
  readonly token: string;
}

export type LoginResult =
  | { readonly ok: true; readonly token: string; readonly user: UserRecord; readonly session: SessionRecord }
  | { readonly ok: false; readonly reason: 'rate_limited' | 'invalid_credentials' };

export type IssuedSession = { readonly token: string; readonly user: UserRecord; readonly session: SessionRecord };

export interface AuthService {
  /** 성공 시 요청에 실려 온 기존 세션(previousToken)을 새 세션 insert **전에** 폐기한다(고아 세션 방지, NC-07). */
  login(email: string, secret: string, previousToken?: string): Promise<LoginResult>;
  /** 검증을 마친 활성 계정에 새 세션을 발급한다(초대 수락). 기존 세션은 먼저 폐기한다. */
  issueSession(user: UserRecord, previousToken?: string): Promise<IssuedSession>;
  authenticate(token: string | undefined): Promise<Authenticated | undefined>;
  logout(auth: Authenticated): Promise<void>;
  /** 로그인 직전 요청에 실려 온 기존 세션을 폐기한다(세션 고정·회전, NC-07). */
  revokeByToken(token: string | undefined): Promise<void>;
  listSessions(auth: Authenticated): Promise<readonly SessionRecord[]>;
}

export interface AuthServiceDeps {
  readonly store: AuthStore;
  readonly limiter: LoginLimiter;
  readonly events: AuthEvents;
  readonly clock: () => number;
}

/**
 * 없는 계정에도 같은 횟수로 해시 검증을 거치게 하는 더미 해시(NC-17).
 * `buildApp` 준비 단계(primeDummyHash)에서 미리 만들어 첫 로그인 응답 시간이 튀지 않게 한다.
 */
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString('base64url'));
  return dummyHash;
}

export async function primeDummyHash(): Promise<void> {
  await getDummyHash();
}

async function checkCredentials(store: AuthStore, email: string, secret: string): Promise<UserRecord | undefined> {
  const user = await store.findUserByEmail(normalizeEmail(email));
  const ok = await verifyPassword(secret, user?.passwordHash ?? (await getDummyHash()));
  return ok && user !== undefined && user.status === 'active' ? user : undefined;
}

/**
 * 로그인 판정(제한 확인 → 해시 검증 → 실패/성공 기록)을 한 번에 하나씩 실행한다.
 * 겹쳐 실행되면 동시 요청이 모두 `isAllowed`를 통과한 뒤에야 실패가 기록돼 S1 상한(계정 5·전역 20)을 넘는다.
 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { store, limiter, events, clock } = deps;
  const now = (): Date => new Date(clock());
  const serial = createSerialQueue();

  async function verifyAttempt(email: string, secret: string): Promise<UserRecord | 'rate_limited' | undefined> {
    const key = normalizeEmail(email);
    if (!limiter.isAllowed(key)) return 'rate_limited';
    const user = await checkCredentials(store, email, secret);
    if (user === undefined) limiter.recordFailure(key);
    else limiter.recordSuccess(key);
    return user;
  }

  async function revoke(session: SessionRecord): Promise<void> {
    await store.revokeSession(session.id, now());
    events.sessionRevoked([session.id]);
  }

  async function revokeByToken(token: string | undefined): Promise<void> {
    if (token === undefined || token === '') return;
    const session = await store.findSessionByTokenHash(hashToken(token));
    if (session !== undefined && session.revokedAt === null) await revoke(session);
  }

  async function issueSession(user: UserRecord, previousToken?: string): Promise<IssuedSession> {
    await revokeByToken(previousToken);
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const createdAt = now();
    const session: SessionRecord = {
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(token),
      createdAt,
      lastSeenAt: createdAt,
      expiresAt: slidingExpiry(createdAt, createdAt),
      revokedAt: null,
    };
    await store.insertSession(session);
    return { token, user, session };
  }

  return {
    async login(email, secret, previousToken) {
      const user = await serial(() => verifyAttempt(email, secret));
      if (user === 'rate_limited') return { ok: false, reason: 'rate_limited' };
      if (user === undefined) return { ok: false, reason: 'invalid_credentials' };
      return { ok: true, ...(await issueSession(user, previousToken)) };
    },

    issueSession,

    async authenticate(token) {
      if (token === undefined || token === '') return undefined;
      const session = await store.findSessionByTokenHash(hashToken(token));
      const at = now();
      if (session === undefined || session.revokedAt !== null || session.expiresAt <= at) return undefined;
      if (at.getTime() >= session.createdAt.getTime() + SESSION_ABSOLUTE_MS) return undefined;
      const user = await store.findUserById(session.userId);
      if (user === undefined || user.status !== 'active') return undefined;
      const expiresAt = slidingExpiry(session.createdAt, at);
      await store.touchSession(session.id, at, expiresAt);
      return { user, token, session: { ...session, lastSeenAt: at, expiresAt } };
    },

    async logout(auth) {
      await revoke(auth.session);
    },

    revokeByToken,

    async listSessions(auth) {
      return store.listLiveSessions(auth.user.id, now());
    },
  };
}
