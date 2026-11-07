/** 메시지 저장소 경계. 운영은 `repo.ts`(pg 단일 트랜잭션), 단위 테스트는 가짜 구현을 쓴다. */
export interface MessageRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly seq: number;
  readonly authorId: string;
  readonly clientMessageId: string;
  readonly threadRootId: string | null;
  readonly body: string | null;
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly deletedAt: Date | null;
  /** 삭제 행은 항상 빈 배열(삭제 트랜잭션이 mention 행을 지운다). */
  readonly mentionUserIds: readonly string[];
  /** 원문만: 살아 있는 답글 수. 답글은 null. */
  readonly rootReplyCount: number | null;
}

export interface NewMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly authorId: string;
  readonly clientMessageId: string;
  readonly threadRootId: string | null;
  readonly body: string;
  readonly mentionUserIds: readonly string[];
  readonly at: Date;
}

export type SendResult =
  | { readonly kind: 'created' | 'replayed'; readonly message: MessageRecord; readonly changeId: number }
  | { readonly kind: 'conflict' | 'not_member' | 'bad_root' };

export interface MessageEdit {
  readonly id: string;
  readonly editorId: string;
  readonly body: string;
  readonly mentionUserIds: readonly string[];
  readonly at: Date;
}

export type WriteResult =
  | { readonly kind: 'ok'; readonly message: MessageRecord; readonly changeId: number }
  | { readonly kind: 'not_found' | 'forbidden' };

/** 메시지 → 대화 해석 결과(B2: `message` 메타 라우트가 assertAccess 입력으로 쓴다). */
export interface MessageLocator {
  readonly conversationId: string;
  readonly authorId: string;
  readonly threadRootId: string | null;
}

export interface PageRequest {
  readonly beforeSeq?: number;
  readonly afterSeq?: number;
  readonly aroundSeq?: number;
  readonly limit: number;
}

export interface Page {
  readonly messages: readonly MessageRecord[];
  readonly hasMore: boolean;
}

export interface MessagesStore {
  locate(messageId: string): Promise<MessageLocator | undefined>;
  /** 대화 행 잠금 → 멱등 키 조회 → 멤버십 재확인 → seq·mention·스레드 대상·change_id를 한 트랜잭션으로 기록한다. */
  send(message: NewMessage): Promise<SendResult>;
  edit(edit: MessageEdit): Promise<WriteResult>;
  remove(id: string, actorId: string, at: Date): Promise<WriteResult>;
  /** top-level 원문만(답글은 페이지 크기를 쓰지 않는다), seq 오름차순. */
  history(conversationId: string, page: PageRequest): Promise<Page>;
  get(messageId: string): Promise<MessageRecord | undefined>;
  /** 한 원문의 답글, seq 오름차순. */
  replies(rootId: string, page: PageRequest): Promise<Page>;
}
