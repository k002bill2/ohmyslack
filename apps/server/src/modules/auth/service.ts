import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthEvents } from './events.js';
import type { LoginLimiter } from './login-limiter.js';
import { hashPassword, normalizeEmail, verifyPassword } from './password.js';
import type { AuthStore, HumanUserRecord, SessionListing, SessionRecord, UserRecord } from './store.js';

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

/** 세션을 받을 수 있는 계정: 사람만. 초대 수락처럼 방금 만든 계정은 `kind` 없이 와도 사람으로 본다. */
export type SessionCandidate = HumanUserRecord | (Omit<HumanUserRecord, 'kind'> & { readonly kind?: 'human' });

export type IssuedSession = { readonly token: string; readonly user: UserRecord; readonly session: SessionRecord };

/**
 * 원격 로그아웃 결과(TRD §5-3 4항). `not_found`는 남의 세션과 없는 세션을 구분하지 않는다(TM-HTTP-21).
 * `gone`은 이미 폐기·만료된 본인 세션(DB 무변경, 멱등 204).
 */
export type RemoteRevokeResult = 'revoked' | 'gone' | 'not_found' | 'current';

export interface AuthService {
  /** 성공 시 요청에 실려 온 기존 세션(previousToken)을 새 세션 insert **전에** 폐기한다(고아 세션 방지, NC-07). */
  /** deviceLabel: 라우트가 User-Agent에서 만든 거친 라벨(TRD §5-3). 원문 UA는 서비스로 오지 않는다. */
  login(email: string, secret: string, previousToken?: string, deviceLabel?: string | null): Promise<LoginResult>;
  /**
   * 검증을 마친 활성 **사람** 계정에 새 세션을 발급한다(초대 수락). 기존 세션은 먼저 폐기한다.
   * 봇은 타입으로 받지 않는다(TRD §5-2 1항: 봇 세션 0). `kind`를 생략한 새 계정은 사람으로 확정한다.
   */
  issueSession(user: SessionCandidate, previousToken?: string, deviceLabel?: string | null): Promise<IssuedSession>;
  authenticate(token: string | undefined): Promise<Authenticated | undefined>;
  /** authenticate와 같은 판정이지만 세션을 연장하지 않는다(WS 트래픽, TRD §5-1 S7). */
  peek(token: string | undefined): Promise<Authenticated | undefined>;
  logout(auth: Authenticated): Promise<void>;
  /** 로그인 직전 요청에 실려 온 기존 세션을 폐기한다(세션 고정·회전, NC-07). */
  revokeByToken(token: string | undefined): Promise<void>;
  listSessions(auth: Authenticated): Promise<readonly SessionListing[]>;
  /**
   * 본인 세션 하나를 원격 폐기한다(FR-AUTH-04, TRD §5-3 4·5항). 현재 요청 세션이면 `current`, 본인 행이 없으면 `not_found`.
   * 폐기는 로그아웃과 같은 저장소 연산(구독 삭제 포함) + 커밋 후 `sessionRevoked` 이벤트(WS 1008 close)다.
   */
  revokeOwnSession(auth: Authenticated, sessionId: string): Promise<RemoteRevokeResult>;
  /**
   * 주어진 세션 ID 중 peek 기준으로 지금 유효한 것만(단일 쿼리, 비연장). 프로세스 밖 폐기를 WS sweep이 잡는 데 쓴다
   * (F-2, NC-21). 저장소가 일괄 조회를 지원할 때만 있다.
   */
  liveSessionIds?(sessionIds: readonly string[]): Promise<ReadonlySet<string>>;
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

/**
 * 봇 계정(TRD §5-2 1항)은 없는 계정과 **같은 경로**를 탄다: 더미 해시로 한 번 검증하고 일반 실패로 끝난다
 * (오류·제한 기록·응답 시간 경로가 사람 로그인 실패와 구별되지 않고, 세션 행을 만들지 않는다).
 */
async function checkCredentials(store: AuthStore, email: string, secret: string): Promise<HumanUserRecord | undefined> {
  const found = await store.findUserByEmail(normalizeEmail(email));
  const human = found?.kind === 'human' ? found : undefined;
  const ok = await verifyPassword(secret, human?.passwordHash ?? (await getDummyHash()));
  return ok && human !== undefined && human.status === 'active' ? human : undefined;
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

  async function verifyAttempt(email: string, secret: string): Promise<HumanUserRecord | 'rate_limited' | undefined> {
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

  async function issueSession(candidate: SessionCandidate, previousToken?: string, deviceLabel?: string | null): Promise<IssuedSession> {
    const user: HumanUserRecord = { ...candidate, kind: 'human' };
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
    await store.insertSession(session, deviceLabel);
    return { token, user, session };
  }

  const isLive = (session: SessionRecord, at: Date): boolean =>
    session.revokedAt === null && session.expiresAt > at && at.getTime() < session.createdAt.getTime() + SESSION_ABSOLUTE_MS;

  const peek = async (token: string | undefined): Promise<Authenticated | undefined> => {
    if (token === undefined || token === '') return undefined;
    const session = await store.findSessionByTokenHash(hashToken(token));
    const at = now();
    if (session === undefined || !isLive(session, at)) return undefined;
    const user = await store.findUserById(session.userId);
    // 봇은 세션이 없다(§5-2). 행이 어떻게든 생겨도 메인 리스너 인증으로 쓰지 않는다.
    if (user === undefined || user.status !== 'active' || user.kind !== 'human') return undefined;
    return { user, token, session };
  };

  const filter = store.filterLiveSessionIds?.bind(store);
  const liveSessionIds =
    filter === undefined
      ? undefined
      : async (sessionIds: readonly string[]): Promise<ReadonlySet<string>> => {
          const at = now();
          const alive = await filter([...new Set(sessionIds)], at, new Date(at.getTime() - SESSION_ABSOLUTE_MS));
          return new Set(alive);
        };

  return {
    ...(liveSessionIds === undefined ? {} : { liveSessionIds }),

    async login(email, secret, previousToken, deviceLabel) {
      const user = await serial(() => verifyAttempt(email, secret));
      if (user === 'rate_limited') return { ok: false, reason: 'rate_limited' };
      if (user === undefined) return { ok: false, reason: 'invalid_credentials' };
      return { ok: true, ...(await issueSession(user, previousToken, deviceLabel)) };
    },

    issueSession,

    peek,

    async authenticate(token) {
      const found = await peek(token);
      if (found === undefined) return undefined;
      const { session, user } = found;
      const at = now();
      const expiresAt = slidingExpiry(session.createdAt, at);
      await store.touchSession(session.id, at, expiresAt);
      return { user, token: found.token, session: { ...session, lastSeenAt: at, expiresAt } };
    },

    async logout(auth) {
      await revoke(auth.session);
    },

    revokeByToken,

    async listSessions(auth) {
      return store.listLiveSessions(auth.user.id, now());
    },

    async revokeOwnSession(auth, sessionId) {
      if (sessionId === auth.session.id) return 'current';
      const session = await store.findUserSession(auth.user.id, sessionId);
      if (session === undefined) return 'not_found';
      if (!isLive(session, now())) return 'gone';
      await revoke(session);
      return 'revoked';
    },
  };
}
