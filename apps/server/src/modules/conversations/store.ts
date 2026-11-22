/** 대화 공간 저장소 경계. 운영은 `repo.ts`(pg 트랜잭션), 단위 테스트는 메모리 구현을 쓴다. */
export type ConversationKind = 'channel' | 'dm';
/** 사용자 종류(`users.kind`). DM 상대 표시(봇 배지·고정)에 쓴다. */
export type PeerKind = 'human' | 'bot';

/** 접근 판정 입력: 대화 종류와 요청자의 **현재**(left_at IS NULL) 멤버십 여부. */
export interface AccessRow {
  readonly kind: ConversationKind;
  readonly activeMember: boolean;
  /** 요청자의 워크스페이스 역할. `manage_bots`·`delete` 판정 때만 읽는다(BOT_CHANNEL_SPEC §4-2, FR-CONV-06). */
  readonly role?: string;
}

/** 봇 채널 추가 결과: 새로 추가·이미 활성 멤버·대상 오류(활성 `kind='bot'`·같은 워크스페이스가 아님). */
export type AddBotResult = 'added' | 'exists' | 'invalid_target';

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
  /** DM 상대의 `users.kind`(비활성 상대 포함, 채널이면 null). */
  readonly peerKind?: PeerKind | null;
  readonly lastSeq: number;
  readonly lastReadSeq: number;
  /** unread·mention·스레드 집계. 목록 쿼리가 계산한 경우에만 있고, 없으면 라우트가 0/[]로 낸다. */
  readonly unread?: UnreadAggregate;
}

export interface UnreadAggregate {
  /** 읽지 않은 top-level 원문(자기·삭제 제외). */
  readonly unreadCount: number;
  readonly mentionCount: number;
  readonly threads: readonly UnreadThread[];
}

export interface UnreadThread {
  readonly rootMessageId: string;
  readonly lastReadSeq: number;
  readonly lastReplySeq: number;
  readonly unreadReplyCount: number;
  readonly mentionCount: number;
}

export interface MemberRow {
  readonly id: string;
  readonly displayName: string;
}

/** 채널 삭제 시점의 활성 멤버(실시간 정리 대상). */
export interface DeletedMember {
  readonly userId: string;
  readonly kind: PeerKind;
}

export type CreateChannelResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'name_taken' | 'no_workspace' };
export type OpenDmResult = { readonly ok: true; readonly id: string } | { readonly ok: false };

export interface ConversationsStore {
  /** withRole이면 워크스페이스 역할도 함께 읽는다(같은 쿼리 1개). */
  findAccess(conversationId: string, userId: string, withRole?: boolean): Promise<AccessRow | undefined>;
  /** 봇 멤버십 UPSERT(joinIn과 같은 규칙). 대상이 대화와 같은 워크스페이스의 활성 봇이 아니면 invalid_target(변경 0). */
  addBot(conversationId: string, botUserId: string, at: Date): Promise<AddBotResult>;
  /**
   * 공개 채널 소프트 삭제(FR-CONV-06): `deleted_at`·`deleted_by` 기록 + 그 시점 활성 멤버 반환(한 트랜잭션).
   * 없는 ID·DM·이미 삭제된 채널이면 undefined(변경 0). 메시지·첨부·멤버 행은 바꾸지 않는다.
   */
  deleteChannel(conversationId: string, deletedBy: string, at: Date): Promise<readonly DeletedMember[] | undefined>;
  /** 활성 **봇** 멤버십에만 left_at을 기록한다(사람 대상은 바뀌지 않음). 바뀐 행이 없으면 false. */
  removeBot(conversationId: string, botUserId: string, at: Date): Promise<boolean>;
  /** 채널 생성 + 생성자 멤버십·read state(한 트랜잭션). 같은 workspace의 같은 name_norm은 name_taken. */
  createChannel(channel: NewChannel): Promise<CreateChannelResult>;
  /** 요청자에게 활성 멤버십이 없는 같은 workspace 공개 채널(id 오름차순 cursor). */
  discover(userId: string, after: string | undefined, limit: number): Promise<readonly ChannelListing[]>;
  /** 참여·재참여: joined_seq=last_seq, read cursor 초기화. 이미 활성 멤버면 바꾸지 않는다. */
  join(conversationId: string, userId: string, at: Date): Promise<void>;
  /** 활성 멤버십에 left_at을 기록한다. 바뀐 행이 없으면 false. */
  leave(conversationId: string, userId: string, at: Date): Promise<boolean>;
  listMembers(conversationId: string): Promise<readonly MemberRow[]>;
  /** 활성 멤버십 대화(id 오름차순 cursor, 최대 limit행). */
  listForUser(userId: string, after: string | undefined, limit: number): Promise<readonly ConversationRow[]>;
  /** 정렬된 pair key로 DM을 찾거나 만든다(두 멤버십 같은 트랜잭션). 상대가 같은 workspace 활성 멤버가 아니면 ok:false. */
  openDm(dm: NewDm): Promise<OpenDmResult>;
}
