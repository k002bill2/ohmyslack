/** 대화 공간 저장소 경계. 운영은 `repo.ts`(pg 트랜잭션), 단위 테스트는 메모리 구현을 쓴다. */
export type ConversationKind = 'channel' | 'dm';

/** 접근 판정 입력: 대화 종류와 요청자의 **현재**(left_at IS NULL) 멤버십 여부. */
export interface AccessRow {
  readonly kind: ConversationKind;
  readonly activeMember: boolean;
}

export interface NewChannel {
  readonly id: string;
  readonly name: string;
  readonly nameNorm: string;
  readonly creatorId: string;
  readonly at: Date;
}

export interface NewDm {
  readonly id: string;
  readonly userId: string;
  readonly peerId: string;
  readonly pairKey: string;
  readonly at: Date;
}

export interface ChannelListing {
  readonly id: string;
  readonly name: string;
}

export interface ConversationRow {
  readonly id: string;
  readonly kind: ConversationKind;
  readonly name: string | null;
  readonly peerUserId: string | null;
  readonly lastSeq: number;
  readonly lastReadSeq: number;
}

export interface MemberRow {
  readonly id: string;
  readonly displayName: string;
}

export type CreateChannelResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'name_taken' | 'no_workspace' };
export type OpenDmResult = { readonly ok: true; readonly id: string } | { readonly ok: false };

export interface ConversationsStore {
  findAccess(conversationId: string, userId: string): Promise<AccessRow | undefined>;
  /** 채널 생성 + 생성자 멤버십·read state(한 트랜잭션). 같은 workspace의 같은 name_norm은 name_taken. */
  createChannel(channel: NewChannel): Promise<CreateChannelResult>;
  /** 요청자에게 활성 멤버십이 없는 같은 workspace 공개 채널(id 오름차순 cursor). */
  discover(userId: string, after: string | undefined, limit: number): Promise<readonly ChannelListing[]>;
  /** 참여·재참여: joined_seq=last_seq, read cursor 초기화. 이미 활성 멤버면 바꾸지 않는다. */
  join(conversationId: string, userId: string, at: Date): Promise<void>;
  /** 활성 멤버십에 left_at을 기록한다. 바뀐 행이 없으면 false. */
  leave(conversationId: string, userId: string, at: Date): Promise<boolean>;
  listMembers(conversationId: string): Promise<readonly MemberRow[]>;
  listForUser(userId: string): Promise<readonly ConversationRow[]>;
  /** 정렬된 pair key로 DM을 찾거나 만든다(두 멤버십 같은 트랜잭션). 상대가 같은 workspace 활성 멤버가 아니면 ok:false. */
  openDm(dm: NewDm): Promise<OpenDmResult>;
}
