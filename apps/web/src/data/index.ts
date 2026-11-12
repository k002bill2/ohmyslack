/**
 * 화면 데이터 주입 경계(W-10b). 운영 구현은 `createHttpDataSource`(HTTP + WS, W-10c).
 * 값 필드는 TRD §3 `GET /api/conversations` 항목 필드(unread_count·mention_count·unread_thread_count)와 대응한다.
 */
import type { PendingMessage } from '../features/conversation';
import type { PushServerApi } from '../features/pwa';
import type { AttachmentView } from '../../../../packages/shared/src/index.js';

export type SpaceKind = 'channel' | 'dm';

export interface Space {
  readonly id: string;
  readonly kind: SpaceKind;
  readonly name: string;
  readonly unreadCount: number;
  readonly mentionCount: number;
  readonly unreadThreadCount: number;
  /** `unread_threads[]` 중 아직 새 답글이 남은 스레드 root id(CMP-14 「새 답글」, W-10i). */
  readonly unreadThreadRoots?: readonly string[];
  /** 이번 세션에 본인이 나간 채널(UI_STATES §2-3 「나간 채널」). 서버 목록은 나간 채널을 주지 않아 클라이언트가 기억한다. */
  readonly left?: boolean;
  /** 상대가 봇(`GET /api/members` kind)인 DM — 목록 최상단 고정 + CMP-26 배지(UI_STATES §2-3 「Jarvis DM」, W-19b). */
  readonly bot?: boolean;
  /** 비활성 상대 DM이면 접미 없는 상대 이름(`name`은 「{이름} (비활성)」 그대로). 화면이 이름·접미를 따로 그린다(QA D3). */
  readonly peerInactiveName?: string;
}

export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly rootId?: string;
  readonly author: string;
  /** 비활성 작성자면 접미 없는 이름(`author`는 「{이름} (비활성)」 그대로 — 접근 이름용). 화면이 이름·접미를 따로 그린다(QA D2). */
  readonly authorInactiveName?: string;
  readonly createdAt: string;
  readonly body: string;
  readonly replyCount: number;
  /** 내 전송 대기 항목(전송 중·저장 여부 확인 중·실패). 저장 확인이면 없음. */
  readonly pending?: PendingMessage;
  /** 서버 메시지 필드(HTTP 구현만 채운다). */
  readonly seq?: number;
  readonly authorId?: string;
  readonly clientMessageId?: string;
  readonly deleted?: boolean;
  /** 서버 `edited_at`(있으면 「(수정됨)」, W-10i). */
  readonly editedAt?: string;
  /** 서버 projection `author_kind`(W-19b). `bot`이면 CMP-26 배지. 없으면 사람으로 본다. */
  readonly authorKind?: 'human' | 'bot';
  /** 서버 projection `attachments`(W-21/W-22). 사람·봇 메시지 공통 CMP-27. */
  readonly attachments?: readonly AttachmentView[];
}

/** 디자인 §6-4 연결 상태 4종. */
export type ConnectionState = 'connected' | 'reconnecting' | 'offline' | 'catching-up';

/** 내 계정(`GET /api/me` user). role로 owner 전용 진입점을 가린다 — 서버 403이 최종 진실. */
export interface Account {
  readonly id: string;
  readonly displayName: string;
  readonly role: 'owner' | 'member';
}

/** 공간 목록 요청 상태(UI_STATES §2-3 로딩·오류). 없으면 `ready`로 본다(메모리 구현). */
export type ListState = 'loading' | 'ready' | 'error';

export interface Snapshot {
  readonly spaces: readonly Space[];
  readonly messages: readonly Message[];
  readonly connection: ConnectionState;
  readonly account?: Account;
  readonly listState?: ListState;
  /**
   * 현재 연 대화 중 이력(`open` → 원문 조회) 요청이 끝난 대화 id. 조회 중·미개방이면 null.
   * 이력 조회가 없는 구현(메모리)은 생략한다 — 생략은 「항상 로드됨」으로 본다(W-11d 구분선 고정 시점, Codex r2 P2).
   */
  readonly loadedHistory?: string | null;
  /** 기존 답글을 끝까지 읽은 스레드 root id들. 답글 조회가 없는 구현(메모리)은 생략 — 「항상 로드됨」(W-23b 위치 복원). */
  readonly loadedReplies?: readonly string[];
  /**
   * 세션 중 활성 멤버 목록(`GET /api/members`)에서 사라진 ID를 알 때마다 오른다(QA D1). 바뀌면 화면이 대화 멤버
   * (멘션 후보·멤버 수)를 다시 읽는다 — 서버가 비활성을 이미 빼서 준다. 없으면 0으로 본다(메모리 구현).
   */
  readonly activeRevision?: number;
  /**
   * 동작(생성·참여·DM)은 성공했지만 아직 목록에서 확인되지 않은 대화 id(목록 재조회 실패). 다음 목록 조회가 성공하면
   * 비워진다 — 성공한 목록에 없으면 정말 없는 것. 없으면 빈 집합으로 본다(메모리 구현, Codex r3 P2).
   */
  readonly pendingIds?: readonly string[];
}

/** 서버 요청 실패: HTTP 상태(+오류 code) 또는 네트워크 오류. */
export type ActionFailure = { readonly status: number; readonly code?: string } | { readonly status: 'network' };

/** 공간 진입 동작 결과. */
export type ActionResult<T> = { readonly ok: true; readonly value: T } | ({ readonly ok: false } & ActionFailure);

export interface DiscoverChannel {
  readonly id: string;
  readonly name: string;
}

export interface Member {
  readonly id: string;
  readonly displayName: string;
  readonly role: 'owner' | 'member';
  /** 서버 `users.kind`(W-19b). 없으면 사람으로 본다. */
  readonly kind?: 'human' | 'bot';
}

/** `POST /api/invites` 2xx(원문 token은 이 응답에서 한 번만 보인다 — 호출자는 메모리에만 둔다). */
export interface Invite {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * 공간 진입점(W-10g): 채널 만들기·찾기·참여·DM·로그아웃. 성공한 생성·참여·DM은 **목록을 다시 읽은 뒤** 대화 ID를 돌려준다
 * — 호출자는 그 ID로 이동(`open`)만 하면 기존 구독·checkpoint 규칙이 그대로 적용된다.
 */
export interface SpacesApi {
  /** `POST /api/conversations`(owner). 409 name_taken·403 forbidden은 실패로 돌려준다. */
  createChannel?(name: string): Promise<ActionResult<string>>;
  /** `GET /api/conversations/discover` 전 페이지. */
  discoverChannels?(): Promise<ActionResult<readonly DiscoverChannel[]>>;
  /** `POST /api/conversations/:id/join`. */
  joinChannel?(conversationId: string): Promise<ActionResult<string>>;
  /** `GET /api/members`. */
  listMembers?(): Promise<ActionResult<readonly Member[]>>;
  /** `POST /api/dms` — 같은 상대면 서버가 기존 DM ID를 돌려준다(FR-CONV-03). */
  startDm?(userId: string): Promise<ActionResult<string>>;
  /** `POST /api/invites`(owner, W-10h). */
  createInvite?(): Promise<ActionResult<Invite>>;
  /** `POST /api/admin/members/:user_id/deactivate`(owner, W-10h). 204 → ok. */
  deactivateMember?(userId: string): Promise<ActionResult<null>>;
  /** 목록 오류 「다시 시도」 — 복귀 절차 1회. */
  reload?(): void;
  /** `POST /api/auth/logout` → 본문·checkpoint 정리 → 세션 종료. */
  logout?(): Promise<void>;
}

export interface DataSource extends SpacesApi, MembershipApi {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  send(
    target: { readonly conversationId: string; readonly rootId?: string },
    body: string,
    mentionUserIds?: readonly string[],
    attachmentIds?: readonly string[],
  ): void;
  /** Web Push 구독 API(W-23, CMP-30). 없으면 PushSettings를 렌더하지 않는다. */
  readonly push?: PushServerApi;
  /** `POST /api/attachments?conversation_id=`(원시 바이트, W-21). 성공하면 미결속 첨부 — `send`의 `attachmentIds`로 결속한다. */
  uploadAttachment?(conversationId: string, file: Blob): Promise<ActionResult<AttachmentView>>;
  /** 현재 대화가 바뀔 때 호출(구독·이력 로드). 메모리 구현은 없음. */
  open?(conversationId: string | null): void;
  /** 스레드를 열거나(root id) 닫을 때(null) 호출 — 기존 답글 조회. 메모리 구현은 없음. */
  openThread?(rootId: string | null): void;
  /**
   * 화면이 실제로 보여 준 마지막 seq(본문: rootId null, 스레드: root id). 전경·현재 대화·단조 조건은 구현이 판정한다
   * (FR-SYNC-03, PRD §7-7). 메모리 구현은 없음.
   */
  markRead?(conversationId: string, rootId: string | null, seq: number): void;
  /** 실패·확인 중 전송 항목 다시 시도/삭제(W-10a 전송 FSM). 메모리 구현은 없음. */
  retry?(clientMessageId: string): void;
  discard?(clientMessageId: string): void;
  /** `PATCH /api/messages/:id`(본인 메시지, W-10i). 2xx면 화면 상태에 이미 반영됐다. */
  editMessage?(messageId: string, body: string): Promise<ActionResult<null>>;
  /** `DELETE /api/messages/:id`(본인 메시지, W-10i). 2xx면 자리표시자로 이미 바뀌었다. */
  deleteMessage?(messageId: string): Promise<ActionResult<null>>;
}

export interface MemoryDataSource extends DataSource {
  setConnection(state: ConnectionState): void;
}

/** 메모리 구현(테스트·개발용). 스냅숏은 매 변경마다 새 객체로 교체한다(불변). */
export function createMemoryDataSource(seed: Snapshot): MemoryDataSource {
  let snapshot: Snapshot = Object.freeze({ ...seed });
  let nextId = 0;
  const listeners = new Set<() => void>();
  const replace = (next: Snapshot) => {
    snapshot = Object.freeze(next);
    listeners.forEach((l) => l());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(target, body) {
      nextId += 1;
      const message: Message = {
        id: `local-${nextId}`,
        conversationId: target.conversationId,
        ...(target.rootId === undefined ? {} : { rootId: target.rootId }),
        author: '나',
        createdAt: new Date().toISOString(),
        body,
        replyCount: 0,
      };
      const messages = snapshot.messages.map((m) =>
        m.id === target.rootId ? { ...m, replyCount: m.replyCount + 1 } : m,
      );
      replace({ ...snapshot, messages: [...messages, message] });
    },
    setConnection(connection) {
      replace({ ...snapshot, connection });
    },
  };
}

/** CMP-12 멘션 후보·채널 나가기(W-10j). 구현이 없으면 화면은 진입점을 렌더하지 않는다. */
export interface MembershipApi {
  /** `DELETE /api/conversations/:id/membership`(204). 성공하면 목록에 「나간 채널」로 남긴다. */
  leaveChannel?(conversationId: string): Promise<ActionResult<null>>;
  /** `GET /api/conversations/:id/members`. */
  listConversationMembers?(
    conversationId: string,
  ): Promise<ActionResult<readonly { readonly id: string; readonly displayName: string; readonly bot?: boolean }[]>>;
  /** `POST /api/conversations/:id/bots` `{bot_user_id}`(owner, FR-BOT-11). 201(추가)·200(이미 멤버) → ok. */
  addBotToChannel?(conversationId: string, botUserId: string): Promise<ActionResult<null>>;
  /** `DELETE /api/conversations/:id/bots/:bot_user_id`(owner, 204 멱등, FR-BOT-11). */
  removeBotFromChannel?(conversationId: string, botUserId: string): Promise<ActionResult<null>>;
}
