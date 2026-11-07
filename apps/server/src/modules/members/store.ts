/** 초대·멤버·비활성화 저장소 경계. 운영은 `repo.ts`(pg 트랜잭션), 단위 테스트는 메모리 구현을 쓴다. */
export interface NewInvite {
  readonly id: string;
  readonly tokenHash: string;
  readonly createdBy: string;
  readonly expiresAt: Date;
}

export interface NewMember {
  readonly id: string;
  readonly emailNorm: string;
  readonly displayName: string;
  readonly passwordHash: string;
}

export interface MemberSummary {
  readonly id: string;
  readonly displayName: string;
  readonly role: 'owner' | 'member';
}

/** 수락 실패 사유는 응답에서 구분하지 않는다(S3·NC-20). 저장소도 실패를 하나로만 알린다. */
export type AcceptResult = { readonly ok: true } | { readonly ok: false };

export type DeactivateResult =
  | { readonly ok: true; readonly revokedSessionIds: readonly string[] }
  | { readonly ok: false; readonly reason: 'not_found' | 'last_owner' | 'forbidden' };

export interface MembersStore {
  insertInvite(invite: NewInvite): Promise<void>;
  /** 미사용·미폐기 초대만 폐기한다. 바뀐 행이 없으면 false. */
  revokeInvite(id: string, at: Date): Promise<boolean>;
  /** 해시 연산 전 사전 확인: 지금 수락 가능한(미사용·미폐기·미만료) token인지. 최종 판정은 acceptInvite가 한다. */
  isInviteUsable(tokenHash: string, now: Date): Promise<boolean>;
  /**
   * 초대 원자적 1회 교환 + member 계정 생성(한 트랜잭션). 만료·사용·폐기·없는 token, 이미 있는 이메일은
   * 모두 `{ok:false}`이고 DB를 바꾸지 않는다.
   */
  acceptInvite(tokenHash: string, now: Date, member: NewMember): Promise<AcceptResult>;
  listActiveMembers(): Promise<readonly MemberSummary[]>;
  /**
   * actor(활성 owner)가 target을 비활성화한다: `users.status=disabled` + target 세션 전부 revoke(한 트랜잭션).
   * 활성 owner가 0명이 되는 변경은 `last_owner`로 거부하고 DB를 바꾸지 않는다(S10).
   */
  deactivate(actorId: string, targetId: string, at: Date): Promise<DeactivateResult>;
}
