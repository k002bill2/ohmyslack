/** auth 서비스가 쓰는 저장소 경계. 운영은 `repo.ts`(pg), 단위 테스트는 메모리 구현을 쓴다. */
interface UserRecordBase {
  readonly id: string;
  readonly emailNorm: string;
  readonly displayName: string;
  readonly status: 'active' | 'disabled';
  readonly role: 'owner' | 'member';
}

/** 사람 계정: 해시가 항상 있다(DB CHECK `(kind='human') = (password_hash IS NOT NULL)`, TRD §2). */
export interface HumanUserRecord extends UserRecordBase {
  readonly kind: 'human';
  readonly passwordHash: string;
}

/** 봇 계정(TRD §5-2): 해시가 없고 이메일 로그인·세션 경로가 없다. */
export interface BotUserRecord extends UserRecordBase {
  readonly kind: 'bot';
  readonly passwordHash: null;
}

export type UserRecord = HumanUserRecord | BotUserRecord;

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/** 목록용 세션: 거친 기기 라벨(TRD §5-3)을 함께 싣는다. 라벨을 읽지 않는 저장소는 생략할 수 있다(null로 본다). */
export type SessionListing = SessionRecord & { readonly deviceLabel?: string | null };

export interface AuthStore {
  findUserByEmail(emailNorm: string): Promise<UserRecord | undefined>;
  findUserById(id: string): Promise<UserRecord | undefined>;
  /** deviceLabel: 로그인 때 만든 거친 라벨(TRD §5-3). 생략하면 저장하지 않는다(DB NULL). */
  insertSession(session: SessionRecord, deviceLabel?: string | null): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | undefined>;
  touchSession(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void>;
  revokeSession(id: string, revokedAt: Date): Promise<void>;
  /** 폐기되지 않고 만료되지 않은 세션(최근 사용 순). */
  listLiveSessions(userId: string, now: Date): Promise<readonly SessionListing[]>;
  /**
   * 그 사용자의 세션 한 행(폐기·만료 포함). 남의 세션과 없는 세션은 같은 undefined다 — `user_id` 조건으로만 조회한다
   * (원격 로그아웃 존재 오라클 0, TRD §5-3 4항·TM-HTTP-21).
   */
  findUserSession(userId: string, id: string): Promise<SessionRecord | undefined>;
  /**
   * 주어진 세션 중 지금 유효한 것(미폐기·미만료·createdAfter 이후 생성·활성 사용자)의 ID만 한 쿼리로 돌려준다.
   * WS sweep(F-2, NC-21)용. 선택 구현: 없으면 hub는 sweep을 켜지 않는다.
   */
  filterLiveSessionIds?(ids: readonly string[], now: Date, createdAfter: Date): Promise<readonly string[]>;
}
