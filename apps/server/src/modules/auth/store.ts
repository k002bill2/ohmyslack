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
}
