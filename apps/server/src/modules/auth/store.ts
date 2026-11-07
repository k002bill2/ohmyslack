/** auth 서비스가 쓰는 저장소 경계. 운영은 `repo.ts`(pg), 단위 테스트는 메모리 구현을 쓴다. */
export interface UserRecord {
  readonly id: string;
  readonly emailNorm: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly status: 'active' | 'disabled';
  readonly role: 'owner' | 'member';
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface AuthStore {
  findUserByEmail(emailNorm: string): Promise<UserRecord | undefined>;
  findUserById(id: string): Promise<UserRecord | undefined>;
  insertSession(session: SessionRecord): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | undefined>;
  touchSession(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void>;
  revokeSession(id: string, revokedAt: Date): Promise<void>;
  /** 폐기되지 않고 만료되지 않은 세션(최근 사용 순). */
  listLiveSessions(userId: string, now: Date): Promise<readonly SessionRecord[]>;
  /**
   * 주어진 세션 중 지금 유효한 것(미폐기·미만료·createdAfter 이후 생성·활성 사용자)의 ID만 한 쿼리로 돌려준다.
   * WS sweep(F-2, NC-21)용. 선택 구현: 없으면 hub는 sweep을 켜지 않는다.
   */
  filterLiveSessionIds?(ids: readonly string[], now: Date, createdAfter: Date): Promise<readonly string[]>;
}
