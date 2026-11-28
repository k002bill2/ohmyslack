/**
 * 운영 DataSource(W-10c): REST(TRD §3) + WS(TRD §4).
 * 복귀 순서: 인증(`GET /api/me`) → `GET /api/sync` 페이지 catch-up(410 → snapshot 절차) → `GET /api/conversations`
 * → 현재 대화 구독 ACK → 그때만 checkpoint 전진·「연결됨」(UI_STATES §5 C2). live 이벤트는 `change_id`로 멱등 병합하고
 * checkpoint를 움직이지 않는다. 401 → 화면 본문·checkpoint 삭제 후 세션 종료(S11).
 */
import type {
  ConversationMembersResponse,
  ConversationRef,
  AttachmentUploadResponse,
  MessageDeleteResponse,
  ConversationsResponse,
  DiscoverResponse,
  MeResponse,
  MembersResponse,
  MessageView,
  MessageWriteResponse,
  RepliesResponse,
  SessionsResponse,
  SnapshotResponse,
  ReadStateResponse,
  SyncResponse,
  WsServerFrame,
} from '../../../../packages/shared/src/index.js';
import { createSendController, type PendingMessage, type PostResult } from '../features/conversation';
import { adoptAccount, clearCheckpoints, readCheckpoint, writeCheckpoint, type SessionBus, type StorageLike } from '../features/sync';
import { pushSubscriptionCreatedSchema, pushSubscriptionCreateSchema, vapidPublicKeyResponseSchema } from '../../../../packages/shared/src/push.js';
import { ATTACHMENT_FILENAME_HEADER } from '../../../../packages/shared/src/attachments.js';
import { messageWriteResponseSchema } from '../../../../packages/shared/src/messages.js';
import { createApi, HttpStatusError, isUnreachable, NetworkError, TimeoutError, type FetchLike } from './api.js';
import { emptyFold, foldDeleted, foldMessage, orderedMessages, type FoldState } from './fold.js';
import type { Account, ActionResult, ConnectionState, DataSource, ListState, Message, Snapshot, Space } from './index.js';
import { createRealtimeClient, type SocketLike } from './realtime.js';
import { probeMark } from '../measure/hook.js';
import { AUTHOR_NAME_COPY } from '../ui/copy.js';
import { lookupUserNames } from './user-names.js';
import { bucketCount, bucketDurationMs, type METRIC_ENUMS } from '../../../../packages/shared/src/metrics.js';
import { createMetricsBuffer, type MetricDims, type MetricsRecorder } from './metrics.js';

export interface HttpDataSourceDeps {
  readonly fetch: FetchLike;
  readonly createSocket: (url: string) => SocketLike;
  readonly wsUrl: string;
  readonly session: SessionBus;
  readonly storage?: StorageLike | null;
  readonly isOnline?: () => boolean;
  readonly newClientMessageId?: () => string;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** 전경 복귀(`visibilitychange`)·`online`/`offline` 이벤트 대상. 없으면 수동 resume만. */
  readonly lifecycle?: { readonly doc: EventTarget & { readonly visibilityState: string }; readonly win: EventTarget };
  /** 계측 기록기(PRD §10 2단계). 없으면 메모리 버퍼(`data/metrics.ts`)를 만들어 `start()`에서 주기·이탈 전송을 건다. */
  readonly metrics?: MetricsRecorder;
  /** 계측 소요 시간 시계(ms). 없으면 `performance.now`. */
  readonly now?: () => number;
}

export interface HttpDataSource extends DataSource {
  /** 생명주기 이벤트를 걸고 첫 복귀 절차를 시작한다. */
  start(): Promise<boolean>;
  /** 복귀 절차 1회. 완료(연결됨)면 true, 실패·중단이면 false. */
  resume(): Promise<boolean>;
  retry(clientMessageId: string): Promise<void>;
  discard(clientMessageId: string): void;
  logout(): Promise<void>;
  stop(): void;
}

/** 끊김 판정: HTTP 네트워크 오류 연속 횟수(디자인 §6-4 제안값). */
const OFFLINE_AFTER_FAILURES = 2;
const HISTORY_LIMIT = 100;
/** 읽음 저장 묶음 지연(BRIEF ★1: 1초 이내 trailing). */
export const READ_FLUSH_MS = 500;
/** 배경 대화 변경 → 목록 재조회 묶음 지연(BRIEF ★2). */
export const BACKGROUND_RELOAD_MS = 300;
/** 읽음 저장 실패 재시도 백오프(Codex r1 P2-3): 1s에서 2배씩, 상한 30s. */
export const READ_RETRY_BASE_MS = 1000;
export const READ_RETRY_MAX_MS = 30_000;

type Summary = ConversationsResponse['conversations'][number];
type SyncTrigger = (typeof METRIC_ENUMS.sync_trigger)[number];
type SyncOutcome = (typeof METRIC_ENUMS.sync_outcome)[number];

/** 화면 연결 상태 → 계측 client_state. `catching-up`은 복귀 절차의 중간 단계라 기록하지 않는다. */
const CLIENT_STATE: Readonly<Partial<Record<ConnectionState, string>>> = Object.freeze({
  connected: 'online',
  offline: 'offline',
  reconnecting: 'reconnecting',
});

/**
 * send·edit 2xx 응답이 shared 계약(`messageWriteResponseSchema`)과 다르다. 서버는 이미 저장했을 수 있어 실패로 단정하지 않고
 * 응답 없는 실패와 같은 「확인 중」 경로로 보낸다(같은 client_message_id 재시도·sync로 수렴). 원시 응답은 담지 않는다(FR-OPS-03).
 */
class ResponseContractError extends Error {
  constructor() {
    super('response_contract');
  }
}

/** write 응답 런타임 검증 — 위반이면 `ResponseContractError`(고정 코드만). */
const parseWriteResponse = (body: unknown): MessageWriteResponse => {
  const parsed = messageWriteResponseSchema.safeParse(body);
  if (!parsed.success) throw new ResponseContractError();
  return parsed.data;
};

/** 구독 거절(`error` 프레임에 대화 ID가 실린 경우). */
class SubscribeRejected extends Error {
  constructor(readonly code: string) {
    super('subscribe rejected');
  }
}

/** 읽음 위치 키: 대화 본문은 대화 ID, 스레드는 `대화:root`. */
const readKey = (conversationId: string, rootId: string | null) => (rootId === null ? conversationId : `${conversationId}:${rootId}`);

/**
 * 목록 항목 → Space. `reads`(WS `read.updated`로 받은 읽음 위치)와 서버 값을 단조 병합해 큰 쪽을 쓴다.
 * 병합한 위치가 마지막 seq에 닿으면 미읽음을 0으로, 스레드는 마지막 답글에 닿으면 미읽음 스레드에서 뺀다.
 */
function toSpace(c: Summary, names: ReadonlyMap<string, string>, reads: ReadonlyMap<string, number>, inactive: ReadonlyMap<string, string>): Space {
  const peer = c.peer_user_id === null ? undefined : names.get(c.peer_user_id);
  const peerInactive = c.name === null && c.peer_user_id !== null ? inactive.get(c.peer_user_id) : undefined;
  const read = Math.max(c.last_read_seq, reads.get(c.id) ?? 0);
  const caughtUp = read > c.last_read_seq && read >= c.last_seq;
  // mention_count는 본문·스레드 합산이라 로컬에서 줄이지 않는다 — read.updated 뒤 목록 재조회(서버 집계)를 따른다(Codex r1 P2).
  const threadsRead = c.unread_threads.filter((t) => {
    const r = Math.max(t.last_read_seq, reads.get(readKey(c.id, t.root_message_id)) ?? 0);
    return r > t.last_read_seq && r >= t.last_reply_seq;
  }).length;
  return {
    id: c.id,
    kind: c.kind,
    name: c.name ?? peer ?? '',
    unreadCount: caughtUp ? 0 : c.unread_count,
    mentionCount: c.mention_count,
    unreadThreadCount: Math.max(0, c.unread_thread_count - threadsRead),
    unreadThreadRoots: unreadRoots(c, reads),
    // 봇 DM 판정은 목록 projection의 peer_kind — 비활성 봇은 GET /api/members(활성만)에 없어도 배지·고정 유지(W-22b, Codex W-19b P2).
    ...(c.kind === 'dm' && c.peer_kind === 'bot' ? { bot: true } : {}),
    ...(peerInactive === undefined ? {} : { peerInactiveName: peerInactive }),
  };
}

/** 새 답글이 남은 스레드 root id(CMP-14): `unread_reply_count > 0`이고 로컬 읽음 위치가 마지막 답글에 닿지 않은 것(W-10i). */
function unreadRoots(c: Summary, reads: ReadonlyMap<string, number>): readonly string[] {
  return c.unread_threads
    .filter((t) => t.unread_reply_count > 0 && (reads.get(readKey(c.id, t.root_message_id)) ?? 0) < t.last_reply_seq)
    .map((t) => t.root_message_id);
}

export function createHttpDataSource(deps: HttpDataSourceDeps): HttpDataSource {
  const storage = deps.storage === undefined ? undefined : deps.storage;
  const isOnline = deps.isOnline ?? (() => navigator.onLine);
  const listeners = new Set<() => void>();
  /** 채널 삭제 알림 구독자(FR-CONV-06) — 화면이 그 대화의 초안·첨부 초안을 버린다. */
  const deletedListeners = new Set<(conversationId: string) => void>();
  let snapshot: Snapshot = Object.freeze({ spaces: [], messages: [], connection: 'catching-up' as ConnectionState, loadedHistory: null });
  let fold: FoldState = emptyFold;
  let spaces: readonly Space[] = [];
  let summaries: readonly Summary[] = [];
  /** 다른 기기 읽음 위치(단조 증가만). 목록을 다시 읽어도 뒤로 가지 않는다. */
  let reads: ReadonlyMap<string, number> = new Map();
  let pending: readonly PendingMessage[] = [];
  let connection: ConnectionState = 'catching-up';
  let account: Account | undefined;
  /** 목록이 한 번이라도 2xx로 왔는가 — 이후 실패는 목록을 유지하고 배너(연결 상태)로만 알린다. */
  let listState: ListState = 'loading';
  /** 목록 조회 시작 순번(발급한 마지막 값). 응답 순서가 바뀌어도 시작 순번으로 신·구를 가린다. */
  let listRequests = 0;
  /** 화면에 반영한 성공 목록 응답 중 가장 늦게 시작된 것의 순번 — 이보다 먼저 시작된 응답은 버린다. */
  let listApplied = 0;
  /**
   * 동작은 성공했지만 목록 재조회가 실패해 아직 확인되지 않은 대화 id → 동작 성공 시점까지 발급한 순번(snapshot `pendingIds`).
   * 이 값보다 나중에 시작된 성공 목록이 반영되면 「목록에 있음/없음」이 확정된다.
   */
  let unlisted: ReadonlyMap<string, number> = new Map();
  let names: ReadonlyMap<string, string> = new Map();
  /** `GET /api/members` kind = bot인 사용자 ID(W-19b): 멘션 후보 배지. 봇 DM 고정·배지는 목록의 peer_kind(W-22b). */
  let bots: ReadonlySet<string> = new Set();
  const noteKinds = (members: MembersResponse['members']) => {
    bots = new Set(members.filter((m) => m.kind === 'bot').map((m) => m.id));
  };
  let userId: string | null = null;
  let checkpoint: number | null = null;
  let current: string | null = null;
  let generation = 0;
  let resuming = false;
  /**
   * 복귀 절차의 HTTP catch-up 구간(인증~목록·emit). 이 구간에 늦게 도착한 WS 종료는 「최신 상태 확인 중」(배지·구분선 보류)을
   * 덮지 않고 기록만 해 두었다가, 구간이 끝난 뒤 소켓이 여전히 닫혀 있으면 「다시 연결 중」으로 바꾼다(W-16 F-5, QA-FR-SYNC-07).
   */
  let inCatchUp = false;
  let closedInCatchUp = false;
  let ended = false;
  let failures = 0;
  const rootFor = new Map<string, string>();
  /** 전송 대기 항목의 작성 시각(로컬). 빈 문자열이면 시각 포맷이 RangeError를 낸다(Codex r1 P1). */
  const createdFor = new Map<string, string>();
  const acks = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  let nextRoot: string | undefined;
  let nextMentions: readonly string[] | undefined;
  /** 전송 대기 항목의 멘션 ID(다시 시도도 같은 ID로 보낸다). */
  const mentionsFor = new Map<string, readonly string[]>();
  let nextAttachments: readonly string[] | undefined;
  /** 전송 대기 항목의 첨부 ID(업로드 완료분만, 다시 시도도 같은 ID). 메모리 전용(B7). */
  const attachmentsFor = new Map<string, readonly string[]>();
  /** 이번 세션에 나간 채널(서버 목록은 `left_at IS NULL`만 준다 — REPORT 계약 부족). 다시 참여하면 지운다. */
  let leftChannels: ReadonlyMap<string, Space> = new Map();
  /** 목록 + 나간 채널(목록에 다시 나타나면 목록이 이긴다). */
  const withLeft = (list: readonly Space[]): readonly Space[] => {
    const ids = new Set(list.map((sp) => sp.id));
    // 다른 탭·기기에서 다시 참여해 서버 목록에 돌아온 채널은 나가기 기억에서도 지운다(Codex r1 P2).
    if ([...leftChannels.keys()].some((id) => ids.has(id))) {
      leftChannels = new Map([...leftChannels].filter(([id]) => !ids.has(id)));
    }
    const all = [...list, ...leftChannels.values()];
    return deleted.size === 0 ? all : all.filter((sp) => !deleted.has(sp.id));
  };
  /** 이번 세션에 삭제된 채널(FR-CONV-06). 삭제 전에 시작된 목록 응답이 늦게 와도 되살리지 않는다. */
  let deleted: ReadonlySet<string> = new Set();
  /** 삭제 제외 목록 — `summaries`는 항상 이 필터를 거친다(목록·배경 구독·open 존재 판정의 단일 정본). */
  const listed = (list: readonly Summary[]): readonly Summary[] => (deleted.size === 0 ? list : list.filter((c) => !deleted.has(c.id)));
  let detach = () => undefined as void;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  /** 배경 구독 중인 대화(현재 대화 제외). 소켓이 닫히면 비운다 — 다음 연결 완료 때 다시 구독한다. */
  let background: ReadonlySet<string> = new Set();
  let reloadTimer: unknown = null;
  let reloading = false;
  let reloadAgain = false;
  /** 보낼 읽음 위치(키별 최대 seq)와 보낸 최대 위치(단조, 같은 값 재송신 방지). */
  let readQueue: ReadonlyMap<string, { readonly conversationId: string; readonly rootId: string | null; readonly seq: number }> = new Map();
  let readSent: ReadonlyMap<string, number> = new Map();
  let readTimer: unknown = null;
  /** 현재 `readTimer`가 실패 재시도(백오프) 타이머인지와 연속 실패 횟수(Codex r1 P2-3). */
  let readTimerIsRetry = false;
  /** `stop()` 뒤: 읽음 송신·재시도·목록 재조회를 예약하지 않는다(`start()`가 다시 연다, Codex r2 P2). */
  let stopped = false;
  /** 답글 이력을 끝까지(has_more=false) 받은 root — 누락 없는 로드 전에는 스레드 읽음을 보내지 않는다(PRD §7-7, Codex r2 P2). */
  let repliesLoaded: ReadonlySet<string> = new Set();
  /** 현재 대화의 이력 조회가 끝났으면 그 id(Snapshot.loadedHistory). */
  let loadedHistory: string | null = null;
  let readFailures = 0;
  /** 오래된 목록 때문에 보류한 스레드 위치 — 목록 재조회 뒤 다시 평가한다(Codex r1 P2-1). */
  let deferredThreadReads: ReadonlyMap<string, { readonly conversationId: string; readonly rootId: string; readonly seq: number }> = new Map();
  /**
   * 화면이 마지막으로 연 스레드(닫으면 null)와 그 대화 — 410 재초기화 뒤 그 답글을 다시 조회한다.
   * 대화 전환·접근 정리·나가기·종료에서 비운다 — 지난 스레드를 다시 조회하지 않게(agy r3 #2b).
   */
  let openRoot: { readonly conversationId: string | null; readonly rootId: string } | null = null;
  /**
   * 답글 조회 세대: snapshot 재초기화·대화 전환·종료에서 올린다. 그 전에 시작한 조회는 남은 페이지를 버린다 — 비워진 fold에
   * 뒤 페이지만 접고 "조회 완료"로 표시하면 앞 페이지 답글이 빠진 채 스레드 읽음이 저장된다(PRD §7-7, agy r3 #2a).
   */
  let repliesEpoch = 0;
  /** root별 진행 중 답글 조회의 세대 — 같은 세대 중복 조회를 막는다. */
  let repliesInFlight: ReadonlyMap<string, number> = new Map();
  /** 생성·참여·DM 직후 호출자가 `open(id)`할 대화 — 배경 구독에서 빼 이중 구독을 막는다. */
  let opening: string | null = null;
  const isVisible = () => (deps.lifecycle?.doc.visibilityState ?? 'visible') === 'visible';

  /** 이름 확인 전에는 빈 이름(UUID를 화면에 내지 않는다, W-10k A). */
  const author = (id: string) => names.get(id) ?? '';
  /** 비활성으로 확인한 사용자 → 접미 없는 이름(QA D2·D3). 활성 멤버 목록에서 다시 보이면 지운다. */
  let inactiveNames: ReadonlyMap<string, string> = new Map();
  const inactiveName = (id: string) => inactiveNames.get(id);
  /** 활성 멤버 목록(대화·워크스페이스)으로 이름을 배운다 — 그 ID는 더 이상 비활성이 아니다. */
  const learnActive = (members: readonly { readonly id: string; readonly display_name: string }[]) => {
    names = new Map([...names, ...members.map((m) => [m.id, m.display_name] as const)]);
    const ids = new Set(members.map((m) => m.id));
    if ([...inactiveNames.keys()].some((id) => ids.has(id))) inactiveNames = new Map([...inactiveNames].filter(([id]) => !ids.has(id)));
  };
  /** 재조회를 이미 시도한 미지 ID(실패·응답에 없음 포함) — 같은 ID로 무한 재조회하지 않는다. */
  const triedAuthors = new Set<string>();
  /** 대화별 in-flight 재조회. */
  const authorFetches = new Map<string, Promise<void>>();

  /** 이름 갱신 뒤 이미 접은 메시지 작성자·DM 이름을 다시 맞춘다(바뀐 항목만 새 객체). */
  const refreshNames = () => {
    let changed = false;
    const messages = new Map(fold.messages);
    for (const [id, m] of fold.messages) {
      const name = m.authorId === undefined ? undefined : names.get(m.authorId);
      const bare = m.authorId === undefined ? undefined : inactiveNames.get(m.authorId);
      if (name !== undefined && (name !== m.author || bare !== m.authorInactiveName)) {
        // 다시 활성이 된 작성자는 키 자체를 뺀다(선택 필드는 undefined 대신 생략).
        const rest = Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'authorInactiveName')) as Message;
        messages.set(id, { ...rest, author: name, ...(bare === undefined ? {} : { authorInactiveName: bare }) });
        changed = true;
      }
    }
    if (changed) fold = { applied: fold.applied, messages };
    spaces = withLeft(summaries.map((c) => toSpace(c, names, reads, inactiveNames)));
    emit();
  };

  /**
   * 멤버 조회에도 없던 ID는 `GET /api/users/names`(비활성 포함)로 찾고, 그래도 없으면 「알 수 없는 사용자」로 굳힌다
   * — 조회가 끝난 뒤 빈 이름 0(G-50·G-51). 나중에 멤버 조회로 실제 이름이 오면 덮어쓴다.
   */
  const settleNames = async (ids: readonly string[], recheck = false) => {
    const want = recheck ? ids : ids.filter((id) => !names.has(id));
    const found = await lookupUserNames(api, want);
    if (ended) return;
    const rest = want.filter((id) => (recheck || !names.has(id)) && !found.has(id));
    names = new Map([...names, ...[...found].map(([id, n]) => [id, n.label] as const), ...rest.map((id) => [id, AUTHOR_NAME_COPY.unknown] as const)]);
    const wanted = new Set(want);
    inactiveNames = new Map([
      ...[...inactiveNames].filter(([id]) => !wanted.has(id)),
      ...[...found].flatMap(([id, n]) => (n.inactiveName === undefined ? [] : [[id, n.inactiveName] as const])),
    ]);
  };

  /** 직전 `GET /api/members`(활성만)의 ID. 세션 중 비활성화돼 목록에서 사라진 ID는 캐시된 이름을 다시 확인한다(Codex r1 P2). */
  let activeIds: ReadonlySet<string> = new Set();
  /** Snapshot.activeRevision — 활성 목록에서 사라진 ID를 알 때마다 +1(QA D1: 대화 멤버·멘션 후보 재조회 신호). */
  let activeRevision = 0;
  const noteActive = (members: MembersResponse['members']) => {
    const next = new Set(members.map((m) => m.id));
    const gone = [...activeIds].filter((id) => !next.has(id));
    activeIds = next;
    if (gone.length > 0) noteGone(gone);
  };
  /** 활성에서 빠진 ID: 대화 멤버 재조회 신호를 올리고(QA D1) 캐시 이름을 「(비활성)」로 다시 확인한다. */
  const noteGone = (gone: readonly string[]) => {
    activeRevision += 1;
    emit();
    void settleNames(gone, true).then(
      () => {
        if (!ended) refreshNames();
      },
      () => undefined,
    );
  };

  const fetchNames = async (conversationId: string, ids: readonly string[]) => {
    try {
      let members: readonly { readonly id: string; readonly display_name: string }[];
      try {
        members = (await api.get<ConversationMembersResponse>(`/api/conversations/${encodeURIComponent(conversationId)}/members`)).members;
      } catch (e) {
        if (!(e instanceof HttpStatusError)) throw e;
        members = (await api.get<MembersResponse>('/api/members')).members;
      }
      if (ended) return;
      learnActive(members);
    } finally {
      if (!ended) {
        await settleNames(ids);
        if (!ended) refreshNames();
      }
    }
  };

  /** 처음 보는 author_id면 그 대화 멤버를 1회 in-flight로 다시 읽는다(초기 이력·sync·WS·답글 공통). */
  /** 재조회 진행 중에 발견한 다른 미지 ID(대화별). 응답 뒤에도 이름이 없으면 1회 후속 조회한다(Codex r1 P2). */
  const waitingAuthors = new Map<string, ReadonlySet<string>>();

  /** 남은 ID는 한 번에 묶는다 — 후속 조회 1회가 모두를 시도한 것으로 친다. */
  const startNameFetch = (conv: string, ids: readonly string[]) => {
    ids.forEach((id) => triedAuthors.add(id));
    const run = fetchNames(conv, ids)
      .catch((e: unknown) => {
        if (!(e instanceof NetworkError) && !(e instanceof HttpStatusError)) throw e;
      })
      .finally(() => {
        authorFetches.delete(conv);
        const waiting = [...(waitingAuthors.get(conv) ?? [])].filter((w) => !names.has(w) && !triedAuthors.has(w));
        waitingAuthors.delete(conv);
        if (waiting.length === 0 || ended) return;
        startNameFetch(conv, waiting);
      });
    authorFetches.set(conv, run);
  };

  const noteAuthor = (view: MessageView) => {
    const id = view.author_id;
    const conv = view.conversation_id;
    if (names.has(id) || triedAuthors.has(id)) return;
    if (authorFetches.has(conv)) {
      waitingAuthors.set(conv, new Set([...(waitingAuthors.get(conv) ?? []), id]));
      return;
    }
    startNameFetch(conv, [id]);
  };

  /** DM 상대가 비활성이면 멤버 조회(활성만)에 없다 — 목록을 받은 뒤 이름 없는 상대만 한 번 찾는다(G-50). */
  const notePeers = () => {
    const peers = summaries.flatMap((c) =>
      c.peer_user_id !== null && c.name === null && !names.has(c.peer_user_id) && !triedAuthors.has(c.peer_user_id) ? [c.peer_user_id] : [],
    );
    if (peers.length === 0) return;
    peers.forEach((id) => triedAuthors.add(id));
    void settleNames(peers).then(
      () => {
        if (!ended) refreshNames();
      },
      () => undefined,
    );
  };

  const foldView = (changeId: number, view: MessageView) => {
    noteAuthor(view);
    return foldMessage(fold, changeId, view, author, inactiveName);
  };

  const pendingAsMessage = (p: PendingMessage): Message => {
    const rootId = rootFor.get(p.clientMessageId);
    return {
      id: `pending:${p.clientMessageId}`,
      conversationId: p.conversationId,
      ...(rootId === undefined ? {} : { rootId }),
      author: author(userId ?? p.authorId),
      createdAt: createdFor.get(p.clientMessageId) ?? new Date().toISOString(),
      body: p.body,
      replyCount: 0,
      pending: p,
    };
  };

  const emit = () => {
    const shown = pending.filter((p) => p.status !== 'confirmed').map(pendingAsMessage);
    snapshot = Object.freeze({
      spaces,
      messages: [...orderedMessages(fold), ...shown],
      connection,
      listState,
      loadedHistory,
      loadedReplies: [...repliesLoaded],
      activeRevision,
      pendingIds: [...unlisted.keys()],
      ...(account === undefined ? {} : { account }),
    });
    listeners.forEach((l) => l());
  };

  const setConnection = (next: ConnectionState) => {
    if (connection === next) return;
    connection = next;
    const state = CLIENT_STATE[next];
    if (state !== undefined) recordMetric('client_state', { state, count: 1 });
    emit();
  };

  /** 401·로그아웃: 화면 본문·대기 항목·checkpoint를 지우고 세션 종료를 알린다(S11, FR-CLIENT-04). */
  const end = (reason: 'unauthorized' | 'logout') => {
    if (ended) return;
    ended = true;
    generation += 1;
    realtime.stop();
    acks.forEach((a) => a.reject(new Error('ended')));
    acks.clear();
    detach();
    fold = emptyFold;
    spaces = [];
    summaries = [];
    leftChannels = new Map();
    reads = new Map();
    readQueue = new Map();
    readSent = new Map();
    deferredThreadReads = new Map();
    repliesLoaded = new Set();
    repliesEpoch += 1;
    repliesInFlight = new Map();
    openRoot = null;
    loadedHistory = null;
    readFailures = 0;
    background = new Set();
    deleted = new Set();
    if (readTimer !== null) clearTimer(readTimer);
    if (reloadTimer !== null) clearTimer(reloadTimer);
    readTimer = null;
    reloadTimer = null;
    pending = [];
    // 진행 중인 오프라인 재전송 루프가 남은 항목을 보내지 않게(Codex r1 P2).
    sendController.reset();
    unlisted = new Map();
    stopMetrics();
    checkpoint = null;
    clearCheckpoints(storage);
    emit();
    deps.session.end(reason);
  };

  const api = createApi({
    fetch: deps.fetch,
    onUnauthorized: () => end('unauthorized'),
    onNetwork: (ok) => {
      failures = ok ? 0 : failures + 1;
      if (failures >= OFFLINE_AFTER_FAILURES) setConnection('offline');
      // C7: 끊김 중 일반 요청이 서버 응답을 받으면 복귀 절차(따라잡기)를 시작한다 — 끊김에서 바로 연결됨으로 가지 않는다(F-8, Codex r1 P2).
      else if (ok && connection === 'offline' && !resuming && !ended && isOnline()) void resume('foreground');
    },
  });

  /**
   * 기본 계측 버퍼: 메모리 전용, 전송은 api 요청 경로(끊김 판정·401 종료)와 분리된 keepalive fetch(`data/metrics.ts`).
   * 주기 타이머는 전역 타이머를 쓴다 — 주입 타이머(`deps.setTimer`: 재연결 백오프·읽음 묶음)의 순서에 끼어들지 않게.
   */
  const metricsBuffer = deps.metrics === undefined ? createMetricsBuffer({ fetch: deps.fetch, csrfToken: () => api.csrfToken() }) : undefined;
  const recorder: MetricsRecorder | undefined = deps.metrics ?? metricsBuffer;
  const now = deps.now ?? (() => performance.now());
  /** 계측 격리: 기록기 예외가 sync·전송·화면 결과를 바꾸지 못하게 삼킨다(기록은 버퍼링만, 전송은 비동기). */
  const recordMetric: MetricsRecorder['record'] = (event, dims) => {
    try {
      recorder?.record(event, dims);
    } catch {
      // 계측 실패는 무시한다.
    }
  };
  /** sync_result 전용: dims 계산(구간화·시계)까지 격리 안에서 한다 — 계측 코드가 던져도 sync 흐름은 그대로. */
  const recordSyncMetric = (trigger: SyncTrigger, outcome: SyncOutcome, changes: number, elapsedMs: () => number) => {
    try {
      recorder?.record('sync_result', syncDims(trigger, outcome, changes, elapsedMs()));
    } catch {
      // 계측 실패는 무시한다.
    }
  };
  let stopMetrics = () => undefined as void;

  /**
   * G-52 경합: DM 전송이 403이면 상대가 비활성화됐을 수 있다 — 상대를 다시 조회해 비활성으로 확인될 때만 반영(작성기 잠김).
   * 조회 실패·응답에 없음은 무시한다(활성 상대 이름을 「알 수 없는 사용자」로 덮지 않게).
   */
  const recheckDmPeer = (conversationId: string) => {
    const peer = summaries.find((c) => c.id === conversationId && c.name === null)?.peer_user_id;
    if (peer === null || peer === undefined || ended) return;
    void lookupUserNames(api, [peer]).then(
      (found) => {
        const hit = found.get(peer);
        if (ended || hit?.inactiveName === undefined) return;
        names = new Map([...names, [peer, hit.label]]);
        inactiveNames = new Map([...inactiveNames, [peer, hit.inactiveName]]);
        refreshNames();
      },
      () => undefined,
    );
  };

  const sendController = createSendController({
    me: '',
    post: async (req): Promise<PostResult> => {
      const rootId = rootFor.get(req.clientMessageId);
      const mentionIds = mentionsFor.get(req.clientMessageId);
      const attachmentIds = attachmentsFor.get(req.clientMessageId);
      try {
        const raw = await api.post<unknown>(`/api/conversations/${encodeURIComponent(req.conversationId)}/messages`, {
          client_message_id: req.clientMessageId,
          body: req.body,
          ...(rootId === undefined ? {} : { thread_root_id: rootId }),
          ...(mentionIds === undefined ? {} : { mention_user_ids: mentionIds }),
          ...(attachmentIds === undefined ? {} : { attachment_ids: attachmentIds }),
        });
        // 계약 위반은 throw → 전송 컨트롤러가 응답 없는 실패와 같이 「확인 중」(unknown)으로 둔다.
        const res = parseWriteResponse(raw);
        if (!ended) fold = foldView(res.change_id, res.message);
        return { ok: true, messageId: res.message.id };
      } catch (e) {
        if (e instanceof HttpStatusError && e.status === 403) recheckDmPeer(req.conversationId);
        if (e instanceof HttpStatusError) return { ok: false, status: e.status };
        throw e;
      }
    },
    newClientMessageId: () => {
      const id = deps.newClientMessageId?.() ?? crypto.randomUUID();
      if (nextRoot !== undefined) rootFor.set(id, nextRoot);
      if (nextMentions !== undefined && nextMentions.length > 0) mentionsFor.set(id, nextMentions);
      if (nextAttachments !== undefined && nextAttachments.length > 0) attachmentsFor.set(id, nextAttachments);
      createdFor.set(id, new Date().toISOString());
      return id;
    },
    isOnline,
    onChange: (items) => {
      // 세션 종료 뒤 늦게 끝난 전송이 본문을 되살리지 않는다(Codex r1 P2).
      if (ended) return;
      pending = items;
      emit();
    },
  });

  const subscribe = (conversationId: string, after: number): Promise<void> =>
    new Promise((resolve, reject) => {
      acks.get(conversationId)?.reject(new Error('superseded'));
      acks.set(conversationId, { resolve, reject });
      if (!realtime.send({ type: 'conversation.subscribe', conversation_id: conversationId, after_cursor: after })) {
        acks.delete(conversationId);
        reject(new Error('socket closed'));
      }
    });

  /**
   * 채널 삭제 확정(FR-CONV-06 — WS `conversation.deleted`·본인 `deleteChannel` 204·`joinChannel` 404만):
   * `deleted` 등록 + 접근 정리(`releaseConversation`) + 초안 폐기 알림·오프라인 전송 큐 폐기·접힌 본문 정리.
   * 현재 대화였으면 화면은 목록에 없는 대화(MissingConversation)로 바뀐다.
   */
  const forgetConversation = (conversationId: string) => {
    deleted = new Set(deleted).add(conversationId);
    if (leftChannels.has(conversationId)) leftChannels = new Map([...leftChannels].filter(([id]) => id !== conversationId));
    releaseConversation(conversationId);
    deletedListeners.forEach((l) => l(conversationId));
    // 오프라인 큐의 메시지가 online 복귀 때 삭제된 대화로 POST되지 않게 버리고, 접힌 본문도 지운다(agy r2).
    sendController.discardConversation(conversationId);
    if ([...fold.messages.values()].some((m) => m.conversationId === conversationId)) {
      fold = { applied: fold.applied, messages: new Map([...fold.messages].filter(([, m]) => m.conversationId !== conversationId)) };
    }
    emit();
  };

  /**
   * 접근 상실·미확정(재연결 구독 not_found·snapshot 404 — 삭제와 다른 기기 나가기를 구분할 수 없다, Aside r3):
   * 구독·배경 구독·ACK·current·읽음 대기열·보류 스레드 읽음을 비우고 목록에서 내린다.
   * 초안·오프라인 전송 큐·`deleted`는 건드리지 않는다 — 다시 참여해 목록에 돌아오면 그대로 이어진다.
   */
  const releaseConversation = (conversationId: string) => {
    if (background.has(conversationId)) {
      background = new Set([...background].filter((b) => b !== conversationId));
      if (realtime.isOpen()) realtime.send({ type: 'conversation.unsubscribe', conversation_id: conversationId });
    }
    if (unlisted.has(conversationId)) unlisted = new Map([...unlisted].filter(([id]) => id !== conversationId));
    if (current === conversationId) {
      // 재연결(runResume) 중이면 접근 거절과 같은 정상 경로(MissingConversation)로 끝나게 not_found로 거절한다(agy).
      acks.get(conversationId)?.reject(new SubscribeRejected('not_found'));
      acks.delete(conversationId);
      current = null;
    }
    summaries = listed(summaries).filter((c) => c.id !== conversationId);
    if ([...readQueue.values()].some((r) => r.conversationId === conversationId)) {
      readQueue = new Map([...readQueue].filter(([, r]) => r.conversationId !== conversationId));
    }
    if ([...deferredThreadReads.values()].some((r) => r.conversationId === conversationId)) {
      deferredThreadReads = new Map([...deferredThreadReads].filter(([, r]) => r.conversationId !== conversationId));
    }
    if (openRoot?.conversationId === conversationId) openRoot = null;
    spaces = spaces.filter((sp) => sp.id !== conversationId);
    emit();
  };

  const onFrame = (frame: WsServerFrame) => {
    if (ended) return;
    if (frame.type === 'conversation.deleted') {
      forgetConversation(frame.conversation_id);
      return;
    }
    if (onBackgroundFrame(frame)) return;
    switch (frame.type) {
      case 'conversation.subscribed':
        acks.get(frame.conversation_id)?.resolve();
        acks.delete(frame.conversation_id);
        return;
      case 'message.created':
      case 'message.updated':
        if (frame.type === 'message.created') probeMark('ws', frame.message.id, frame.message.created_at);
        fold = foldView(frame.change_id, frame.message);
        if (frame.type === 'message.created' && frame.message.author_id === userId) {
          const key = { conversationId: frame.conversation_id, authorId: '', clientMessageId: frame.message.client_message_id };
          sendController.messageCreated(key, frame.message.id);
        }
        emit();
        // 현재 대화의 남의 답글: 스레드 unread 대상(서버 집계)을 목록 재조회로 맞춘다 — 열린 스레드 읽음 저장의 전제(Codex r1 P2-1).
        if (frame.type === 'message.created' && frame.message.thread_root_id != null && frame.message.author_id !== userId) scheduleReload();
        if (frame.type === 'message.created') probeMark('emit', frame.message.id, frame.message.created_at);
        return;
      case 'message.deleted':
        fold = foldDeleted(fold, frame);
        emit();
        return;
      case 'sync.required':
        void resume('reconnect');
        return;
      case 'read.updated':
        applyRead(frame.conversation_id, frame.thread_root_id, frame.last_read_seq);
        return;
      case 'error':
        // 대화 ID가 실린 오류는 그 대화의 구독 거절 — ACK 대기를 끝낸다(Codex r3 P2).
        if (frame.conversation_id !== undefined) {
          acks.get(frame.conversation_id)?.reject(new SubscribeRejected(frame.code));
          acks.delete(frame.conversation_id);
        }
        if (frame.code === 'cursor_expired') void resume('reconnect');
        return;
      default:
        return;
    }
  };

  /**
   * 배경 대화 프레임(BRIEF ★2): 본문은 fold에 넣지 않고 목록 재조회 1회로 묶어 unread·멘션·스레드 수를 맞춘다.
   * 구독 거절·오류는 조용히 배경 집합에서 뺀다(복귀 절차·checkpoint와 무관). 처리했으면 true.
   */
  const onBackgroundFrame = (frame: WsServerFrame): boolean => {
    if (!('conversation_id' in frame) || typeof frame.conversation_id !== 'string') return false;
    const id = frame.conversation_id;
    if (id === current || !background.has(id)) return false;
    switch (frame.type) {
      case 'message.created':
      case 'message.updated':
        if (frame.message.author_id !== userId) scheduleReload();
        return true;
      case 'message.deleted':
        scheduleReload();
        return true;
      case 'conversation.subscribed':
        return true;
      case 'error':
        background = new Set([...background].filter((b) => b !== id));
        return true;
      default:
        return false;
    }
  };

  /** 목록 재조회 묶음: trailing 지연 + in-flight 1개(진행 중 요청이 끝나면 1회 더). */
  const scheduleReload = () => {
    if (stopped) return;
    if (reloading) {
      reloadAgain = true;
      return;
    }
    if (reloadTimer !== null) return;
    reloadTimer = setTimer(() => {
      reloadTimer = null;
      reloading = true;
      void loadList()
        .then(
          () => {
            if (!ended) emit();
          },
          () => undefined,
        )
        .finally(() => {
          reloading = false;
          if (reloadAgain && !ended) {
            reloadAgain = false;
            scheduleReload();
          }
        });
    }, BACKGROUND_RELOAD_MS);
  };

  /** 참여 중(나가지 않은) 대화 전부를 배경 구독으로 맞춘다. 연결됨 상태에서만(따라잡기 중 보류, UI_STATES C1–C2). */
  const syncBackground = () => {
    if (ended || checkpoint === null || connection !== 'connected' || !realtime.isOpen()) return;
    const want = new Set(summaries.map((c) => c.id).filter((id) => id !== current && id !== opening && !leftChannels.has(id)));
    for (const id of background) {
      if (!want.has(id) && id !== current) realtime.send({ type: 'conversation.unsubscribe', conversation_id: id });
    }
    const after = checkpoint;
    const next = new Set<string>();
    for (const id of want) {
      if (background.has(id) || realtime.send({ type: 'conversation.subscribe', conversation_id: id, after_cursor: after })) next.add(id);
    }
    background = next;
  };

  const realtime = createRealtimeClient({
    url: deps.wsUrl,
    createSocket: deps.createSocket,
    onFrame,
    onOpen: () => {
      if (!resuming && !ended) void resume('reconnect');
      opened?.();
    },
    onClose: ({ policy }) => {
      acks.forEach((a) => a.reject(new Error('socket closed')));
      acks.clear();
      background = new Set();
      sendController.wsClosed();
      // 1008: 세션 종료 가능성 — 복귀 절차의 `GET /api/me`가 401이면 end(), 200이면 소켓 재연결·catch-up·구독(UI_STATES C9, Codex r3 P2).
      if (policy) void resume('reconnect');
      else if (inCatchUp) closedInCatchUp = true;
      else if (connection !== 'offline') setConnection('reconnecting');
    },
    ...(deps.setTimer === undefined ? {} : { setTimer: deps.setTimer }),
    ...(deps.clearTimer === undefined ? {} : { clearTimer: deps.clearTimer }),
  });

  let opened: (() => void) | null = null;
  const waitOpen = (): Promise<void> =>
    realtime.isOpen()
      ? Promise.resolve()
      : new Promise((resolve) => {
          opened = () => {
            opened = null;
            resolve();
          };
        });

  /** REST로 받은 내 메시지가 전송 대기(unknown) 항목과 같은 client_message_id면 확정한다(Codex r2 P2). */
  const confirmOwn = (m: MessageView) => {
    if (m.author_id !== userId) return;
    sendController.messageCreated({ conversationId: m.conversation_id, authorId: '', clientMessageId: m.client_message_id }, m.id);
  };

  /** 이번 sync 구간에 접은 변경 수(계측 caught_up_count). `syncPhase`가 시작 때 0으로 되돌린다. */
  let changesApplied = 0;
  /** 이번 복귀 절차(재시도 포함)의 마지막 실패한 sync 결과(시작 시각은 첫 시도 것). resume이 절차를 마칠 때 sync_result 1건으로 기록하고 비운다. */
  let syncReport: { readonly outcome: SyncOutcome; readonly changes: number; readonly startedAt: number; readonly endedAt: number } | null = null;
  /**
   * 이번 복귀 절차에서 sync_result를 이미 기록했는지. sync가 성공(던지지 않음)하면 그 자리에서 바로 기록한다 — 뒤이은 목록 로드·
   * 소켓 열림 대기(waitOpen, 상한 없음)에 기록이 묶이지 않게. 실패는 재시도 여부가 정해지는 resume 끝에서 1건만 기록한다.
   */
  let syncRecorded = false;
  const foldChanges = (res: SyncResponse) => {
    changesApplied += res.changes.length;
    for (const c of res.changes) {
      fold = foldView(c.change_id, c.message);
      confirmOwn(c.message);
    }
  };

  /** 페이지 catch-up. 첫 페이지 watermark(`through_cursor`)를 후속 페이지에 그대로 전달한다(TRD §3). */
  const catchUp = async (after: number): Promise<number> => {
    let res = await api.get<SyncResponse>(`/api/sync?after=${after}`);
    const through = res.through_cursor;
    foldChanges(res);
    while (res.has_more) {
      res = await api.get<SyncResponse>(`/api/sync?after=${res.next_cursor}&through=${through}`);
      foldChanges(res);
    }
    return through;
  };

  /** `next_cursor`가 null이 될 때까지 모든 페이지를 합친다(Codex r1 P2). */
  const loadList = async () => {
    listRequests += 1;
    const startedAt = listRequests;
    let page = await api.get<ConversationsResponse>('/api/conversations');
    const all = [...page.conversations];
    while (page.next_cursor !== null) {
      page = await api.get<ConversationsResponse>(`/api/conversations?after=${encodeURIComponent(page.next_cursor)}`);
      all.push(...page.conversations);
    }
    // 세션 종료 뒤 늦게 도착한 목록 응답은 버린다(Codex r1 P2).
    if (ended) return [];
    // 더 늦게 시작된 성공 응답을 이미 반영했다 — 오래된 목록이 최신 목록·pending을 덮지 않게 버리고 반영된 목록을 돌려준다(PR 28 Codex r4 P2).
    if (startedAt < listApplied) return summaries;
    listApplied = startedAt;
    summaries = listed(all);
    spaces = withLeft(summaries.map((c) => toSpace(c, names, reads, inactiveNames)));
    listState = 'ready';
    // 성공한 목록이 진실 — 동작 성공 뒤에 시작된 조회면 그 id는 이제 「목록에 있음/없음」이 확정됐다.
    // 동작 성공 전에 시작된 조회(동작 전 상태)는 확정할 수 없으므로 남긴다.
    unlisted = new Map([...unlisted].filter(([, succeededAt]) => startedAt <= succeededAt));
    notePeers();
    syncBackground();
    retryDeferredThreadReads();
    return summaries;
  };

  /** 거절된 대화를 현재 대화에서 내리고 목록을 다시 읽는다(접근 권한이 사라졌으면 목록에서도 빠진다). */
  const release = async (conversationId: string) => {
    if (current === conversationId) current = null;
    const list = await loadList();
    // not_found + 다시 읽은 목록에도 없음 → 오프라인 중 삭제 또는 다른 기기에서 나감(구분 불가): 접근 정리만 한다(Aside r3).
    // 초안·전송 큐·`deleted`는 남긴다 — 다시 참여하면 목록이 되살린다.
    if (!ended && !list.some((c) => c.id === conversationId) && !leftChannels.has(conversationId)) releaseConversation(conversationId);
    if (!ended) emit();
  };

  /** WS `read.updated`: 읽음 위치를 단조 병합해 배지를 즉시 다시 계산하고, 멘션·부분 읽음은 서버 집계(목록 재조회)로 맞춘다. */
  const applyRead = (conversationId: string, rootId: string | null, seq: number) => {
    const key = readKey(conversationId, rootId);
    if (seq <= (reads.get(key) ?? 0)) return;
    reads = new Map(reads).set(key, seq);
    spaces = withLeft(summaries.map((c) => toSpace(c, names, reads, inactiveNames)));
    emit();
    void loadList().then(
      () => {
        if (!ended) emit();
      },
      () => undefined,
    );
  };

  /** 새 기기·410: 목록 → 대화별 snapshot → 첫 snapshot_cursor부터 catch-up(TRD §3). */
  const snapshotProcedure = async (): Promise<number> => {
    // snapshot이 정본: 만료 기간의 수정·삭제가 이전 applied change_id에 막혀 무시되지 않도록 fold를 새로 쌓는다(Codex r1 P1).
    fold = emptyFold;
    // 답글 로드 완료·보류 위치도 옛 fold 기준이다 — 비우고, 열린 스레드는 snapshot 뒤 다시 끝까지 조회한다(agy r2 #3).
    repliesLoaded = new Set();
    deferredThreadReads = new Map();
    repliesEpoch += 1;
    let first: number | null = null;
    for (const c of await loadList()) {
      if (deleted.has(c.id)) continue;
      let snap: SnapshotResponse;
      try {
        snap = await api.get<SnapshotResponse>(`/api/sync/snapshot?conversation_id=${encodeURIComponent(c.id)}`);
      } catch (e) {
        // 목록 뒤 순회 중 접근을 잃은 대화(404 — 삭제 또는 다른 기기에서 나감)는 접근 정리만 하고 계속한다(agy r2, Aside r3).
        if (!(e instanceof HttpStatusError) || e.status !== 404) throw e;
        releaseConversation(c.id);
        continue;
      }
      first ??= snap.snapshot_cursor;
      for (const m of snap.messages) {
        fold = foldView(0, m);
        confirmOwn(m);
      }
    }
    const through = await catchUp(first ?? 0);
    if (openRoot !== null && !ended) void loadReplies(openRoot.rootId);
    return through;
  };

  const loadMembers = async () => {
    try {
      const res = await api.get<MembersResponse>('/api/members');
      learnActive(res.members);
      noteKinds(res.members);
      noteActive(res.members);
    } catch (e) {
      if (!(e instanceof NetworkError) && !(e instanceof HttpStatusError)) throw e;
    }
  };

  /**
   * catch-up(checkpoint 없음 → snapshot, 410 → snapshot 재초기화) 1회. sync_result는 복귀 절차(재시도 포함)당 1건(결과 단위, QA P3-2):
   * 성공은 여기서 바로 기록하고, 실패는 결과만 `syncReport`에 남겨 재시도 여부가 정해지는 resume 끝에서 기록한다. 다른 복귀·종료가
   * 끼어들었으면(gen) 결과가 아니므로 남기지 않는다. 410 뒤 재초기화까지 실패하면 client_state resync_error는 시도마다 남긴다.
   */
  const syncPhase = async (gen: number, trigger: SyncTrigger, saved: number | null): Promise<number> => {
    // 소요 시간은 이 절차의 첫 sync 시작부터 잰다 — 재시도해도 시작 시각은 첫 시도 것을 유지한다.
    const startedAt = syncReport?.startedAt ?? now();
    changesApplied = 0;
    let resynced = false;
    let outcome: SyncOutcome = 'ok';
    try {
      let watermark: number;
      try {
        watermark = saved === null ? await snapshotProcedure() : await catchUp(saved);
      } catch (e) {
        if (!(e instanceof HttpStatusError) || e.status !== 410) throw e;
        resynced = true;
        outcome = 'resync_required';
        watermark = await snapshotProcedure();
      }
      // 성공한 sync는 이 절차의 최종 sync 결과다 — 바로 기록한다(뒤 단계가 서버 불가로 재시도해도 syncRecorded로 1건).
      if (gen === generation && !syncRecorded) {
        syncRecorded = true;
        syncReport = null;
        recordSyncMetric(trigger, outcome, changesApplied, () => now() - startedAt);
      }
      return watermark;
    } catch (e) {
      if (resynced && gen === generation) recordMetric('client_state', { state: 'resync_error', count: 1 });
      outcome = e instanceof TimeoutError ? 'timeout' : 'failed';
      // 실패는 재시도 여부가 정해지는 resume 끝에서 기록한다.
      if (gen === generation) syncReport = { outcome, changes: changesApplied, startedAt, endedAt: now() };
      throw e;
    }
  };

  const runResume = async (gen: number, trigger: SyncTrigger): Promise<boolean> => {
    const me = await api.get<MeResponse>('/api/me');
    if (gen !== generation) return false;
    api.setCsrf(me.csrf_token);
    userId = me.user.id;
    names = new Map(names).set(me.user.id, me.user.display_name);
    account = { id: me.user.id, displayName: me.user.display_name, role: me.user.role };
    adoptAccount(userId, storage);
    // 이름이 먼저 있어야 catch-up·snapshot 메시지 작성자와 DM 이름이 UUID·빈 값으로 굳지 않는다(Codex r1 P2).
    await loadMembers();
    if (gen !== generation) return false;
    realtime.start();
    const watermark = await syncPhase(gen, trigger, readCheckpoint(userId, storage));
    await loadList();
    if (gen !== generation) return false;
    emit();
    endCatchUp();
    // 복귀 중 대화가 바뀌었으면 바뀐 대화를 다시 구독한다 — 현재 대화의 ACK 뒤에만 연결됨·checkpoint 전진(Codex r2 P2).
    for (let target = current; target !== null; target = current) {
      await waitOpen();
      // 소켓을 기다리는 동안 삭제(forgetConversation)·전환됐으면 그 대화는 구독하지 않는다(agy r2).
      if (current !== target) continue;
      try {
        await subscribe(target, watermark);
      } catch (e) {
        // 접근 거절(not_found)만 현재 대화를 내린다. cursor_expired 등은 프레임 처리가 시작한 복귀 절차가 재구독한다(Codex r1 P2).
        if (!(e instanceof SubscribeRejected) || e.code !== 'not_found') throw e;
        if (gen !== generation) return false;
        await release(target);
        continue;
      }
      if (gen !== generation) return false;
      if (current === target) break;
    }
    if (gen !== generation) return false;
    checkpoint = watermark;
    writeCheckpoint(userId, watermark, storage);
    failures = 0;
    setConnection('connected');
    syncBackground();
    // 따라잡기 중 보류한 읽음 위치를 연결 완료 뒤 보낸다(BRIEF ★1, UI_STATES C1–C2).
    flushReads();
    return true;
  };

  /** 읽음 위치 하한: 서버 목록 값·`read.updated`·이미 보낸 값 중 최대(단조, TRD §3). */
  const readFloor = (conversationId: string, rootId: string | null): number => {
    const key = readKey(conversationId, rootId);
    const c = summaries.find((x) => x.id === conversationId);
    const server = rootId === null ? (c?.last_read_seq ?? 0) : (c?.unread_threads.find((t) => t.root_message_id === rootId)?.last_read_seq ?? 0);
    return Math.max(server, reads.get(key) ?? 0, readSent.get(key) ?? 0);
  };

  /** 묶인 읽음 위치를 보낸다. 연결됨이 아니면(따라잡기·끊김) 보류한다. 4xx는 버리고, 네트워크 오류는 다음 기회에 다시 보낸다. */
  const flushReads = () => {
    if (readTimer !== null) clearTimer(readTimer);
    readTimer = null;
    readTimerIsRetry = false;
    if (ended || stopped || connection !== 'connected' || readQueue.size === 0) return;
    const batch = [...readQueue.values()];
    readQueue = new Map();
    for (const item of batch) {
      const key = readKey(item.conversationId, item.rootId);
      if (item.seq <= readFloor(item.conversationId, item.rootId)) continue;
      readSent = new Map(readSent).set(key, item.seq);
      const startedAt = now();
      api
        .put<ReadStateResponse>('/api/read-state', {
          conversation_id: item.conversationId,
          thread_root_id: item.rootId,
          last_read_seq: item.seq,
        })
        .then(
          (res) => {
            if (ended) return;
            // 서버는 max로 병합한다 — 보낸 값보다 낮게 돌아오면 저장 위치가 어긋난 것(mismatch). 높으면 다른 기기 위치라 정상.
            recordMetric('read_sync_result', { outcome: res.last_read_seq < item.seq ? 'mismatch' : 'ok', duration_ms: bucketDurationMs(now() - startedAt) });
            readFailures = 0;
            applyRead(res.conversation_id, res.thread_root_id, res.last_read_seq);
          },
          (e: unknown) => {
            if (!ended) recordMetric('read_sync_result', { outcome: 'failed', duration_ms: bucketDurationMs(now() - startedAt) });
            const transient = e instanceof NetworkError || (e instanceof HttpStatusError && e.status >= 500);
            if (!transient || ended) return;
            // 네트워크 오류·5xx: 보낸 기록을 되돌리고 대기열에 다시 넣은 뒤 백오프 재시도를 예약한다(Codex r1 P2-2·3). 4xx는 버린다.
            const sent = new Map(readSent);
            if (sent.get(key) === item.seq) sent.delete(key);
            readSent = sent;
            if ((readQueue.get(key)?.seq ?? 0) < item.seq) readQueue = new Map(readQueue).set(key, item);
            scheduleReadRetry();
          },
        );
    }
  };

  /** 실패한 읽음 재시도: 1s→2s→4s… 상한 30s. 연결됨이 아니면 복귀 완료 때 `flushReads`가 보낸다. */
  const scheduleReadRetry = () => {
    if (stopped || readTimer !== null || readQueue.size === 0) return;
    const delay = Math.min(READ_RETRY_BASE_MS * 2 ** readFailures, READ_RETRY_MAX_MS);
    readFailures += 1;
    readTimerIsRetry = true;
    readTimer = setTimer(flushReads, delay);
  };

  /** 목록 재조회 뒤 보류한 스레드 위치를 다시 평가한다 — 서버 unread 대상 root일 때만 통과한다(PRD §7-7). */
  const retryDeferredThreadReads = () => {
    if (deferredThreadReads.size === 0) return;
    const items = [...deferredThreadReads.values()];
    deferredThreadReads = new Map();
    for (const item of items) markRead(item.conversationId, item.rootId, item.seq, false);
  };

  /**
   * 화면이 실제로 보여 준 위치(BRIEF ★1, PRD §7-7): 전경·현재 대화일 때만 받는다. 스레드는 서버 unread 대상 root일 때만.
   * 같은 키는 최대 seq로 합치고 trailing 지연 뒤 보낸다.
   */
  function markRead(conversationId: string, rootId: string | null, seq: number, defer = true): void {
    if (ended || conversationId !== current || !isVisible()) return;
    const key = readKey(conversationId, rootId);
    // 답글 이력 로드가 끝나기 전 위치는 버린다(표시 안 된 중간 답글 보호, PRD §7-7). 보류했다 되살리면 그새 닫거나 위로
    // 올렸어도 저장된다(agy r2 #3) — 로드 완료 emit 뒤 열려 있는 화면이 그때 위치로 다시 보고한다(ThreadPanel reportSeen).
    if (rootId !== null && !repliesLoaded.has(rootId)) return;
    if (rootId !== null) {
      const c = summaries.find((x) => x.id === conversationId);
      if (c?.unread_threads.some((t) => t.root_message_id === rootId) !== true) {
        // 목록이 오래됐을 수 있다: 다음 재조회 뒤 다시 평가한다(재조회 결과에도 없으면 버린다).
        if (defer && seq > (deferredThreadReads.get(key)?.seq ?? 0)) deferredThreadReads = new Map(deferredThreadReads).set(key, { conversationId, rootId, seq });
        return;
      }
    }
    if (seq <= readFloor(conversationId, rootId) || seq <= (readQueue.get(key)?.seq ?? 0)) return;
    readQueue = new Map(readQueue).set(key, { conversationId, rootId, seq });
    // 새 위치는 백오프 대기 중이어도 짧은 묶음 지연으로 다시 예약한다(대기열 전체를 함께 보낸다).
    if (readTimer !== null && readTimerIsRetry) {
      clearTimer(readTimer);
      readTimer = null;
      readTimerIsRetry = false;
    }
    if (readTimer === null && !stopped) readTimer = setTimer(flushReads, READ_FLUSH_MS);
  }

  /** catch-up 구간 종료: 그 사이 소켓이 닫혔고 아직 다시 열리지 않았으면 이제 「다시 연결 중」을 보인다(F-5). */
  const endCatchUp = () => {
    const closed = closedInCatchUp;
    inCatchUp = false;
    closedInCatchUp = false;
    if (closed && connection === 'catching-up' && !realtime.isOpen()) setConnection('reconnecting');
  };

  /** `trigger`: sync_result 계측의 복귀 계기. 생략하면 첫 연결(`start()`·직접 호출). */
  const resume = async (trigger: SyncTrigger = 'connect', retried = false): Promise<boolean> => {
    if (ended) return false;
    // 새 복귀 절차면 이전 결과를 비운다. 재시도는 첫 시도 결과·시작 시각을 이어받는다(첫 시도 sync 실패 뒤 /api/me에서 실패해도 1건).
    if (!retried) {
      syncReport = null;
      syncRecorded = false;
    }
    generation += 1;
    const gen = generation;
    resuming = true;
    inCatchUp = true;
    setConnection(connection === 'offline' && !isOnline() ? 'offline' : 'catching-up');
    try {
      return await runResume(gen, trigger);
    } catch (e) {
      if (gen !== generation || ended) return false;
      // 목록을 아직 한 번도 받지 못했으면 사이드바 오류 상태(UI_STATES §2-3 「오류」 + 「다시 시도」).
      if (listState !== 'ready' && (!isUnreachable(e) || retried)) {
        listState = 'error';
        emit();
      }
      // 서버 불가(네트워크 오류·게이트웨이 응답, F-8): 최신으로 표시하지 않는다. 1회뿐이면 한 번 더 시도해 끊김 판정을 확정한다.
      // 재시도는 복귀 절차당 1회 — 중간 HTTP 성공이 실패 횟수를 초기화해도 무한 재호출하지 않는다(Codex r1 P2).
      if (isUnreachable(e) && !retried) return resume(trigger, true);
      if (isUnreachable(e)) setConnection('offline');
      return false;
    } finally {
      if (gen === generation) {
        resuming = false;
        if (inCatchUp) endCatchUp();
        // 실패 결과는 마지막 시도에서만 기록한다 — 재시도가 세대를 올리므로 앞선 시도의 finally는 여기 오지 않는다.
        const report = syncReport;
        syncReport = null;
        if (report !== null && !syncRecorded) recordSyncMetric(trigger, report.outcome, report.changes, () => report.endedAt - report.startedAt);
      }
    }
  };

  const loadHistory = async (conversationId: string) => {
    try {
      const res = await api.get<{ messages: SnapshotResponse['messages'] }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${HISTORY_LIMIT}&roots_only=true`,
      );
      if (ended) return;
      for (const m of res.messages) fold = foldView(0, m);
    } catch (e) {
      if (!(e instanceof NetworkError) && !(e instanceof HttpStatusError)) throw e;
    }
    if (ended) return;
    // 실패해도 「끝남」으로 알린다 — 화면은 가진 원문으로 계산한다. 그새 다른 대화로 옮겼으면 표시하지 않는다.
    if (current === conversationId) loadedHistory = conversationId;
    emit();
  };

  /** 스레드 기존 답글: `after_seq`로 오름차순 페이지를 끝까지 읽는다(TRD §3 replies, Codex r2 P1). */
  const loadReplies = async (rootId: string) => {
    const epoch = repliesEpoch;
    if (repliesInFlight.get(rootId) === epoch) return;
    repliesInFlight = new Map(repliesInFlight).set(rootId, epoch);
    const path = `/api/messages/${encodeURIComponent(rootId)}/replies`;
    try {
      let after = 0;
      for (;;) {
        const res = await api.get<RepliesResponse>(`${path}?after_seq=${after}&limit=${HISTORY_LIMIT}`);
        // 그새 snapshot·대화 전환·종료로 세대가 바뀌었으면 fold·로드 완료를 건드리지 않고 끝낸다.
        if (ended || epoch !== repliesEpoch) return;
        fold = foldView(0, res.root);
        for (const m of res.replies) fold = foldView(0, m);
        emit();
        const last = res.replies.at(-1);
        if (!res.has_more || last === undefined) {
          repliesLoaded = new Set(repliesLoaded).add(rootId);
          emit();
          retryDeferredThreadReads();
          return;
        }
        after = last.seq;
      }
    } catch (e) {
      if (!(e instanceof NetworkError) && !(e instanceof HttpStatusError)) throw e;
    } finally {
      if (repliesInFlight.get(rootId) === epoch) repliesInFlight = new Map([...repliesInFlight].filter(([id]) => id !== rootId));
    }
  };

  /** 요청 실패를 ActionResult로. 401은 api가 이미 세션 종료를 처리했다. */
  const attempt = async <T>(run: () => Promise<T>): Promise<ActionResult<T>> => {
    try {
      return { ok: true, value: await run() };
    } catch (e) {
      if (e instanceof TimeoutError) return { ok: false, status: 'network', timedOut: true };
      if (e instanceof NetworkError) return { ok: false, status: 'network' };
      // 계약 위반 2xx: 서버 동작 여부를 확인하지 못했다(timedOut 문구) — 실패로 단정하지 않는다.
      if (e instanceof ResponseContractError) return { ok: false, status: 'network', timedOut: true };
      if (e instanceof HttpStatusError) return e.code === undefined ? { ok: false, status: e.status } : { ok: false, status: e.status, code: e.code };
      throw e;
    }
  };

  /** 생성·참여·DM 성공 뒤: 목록 갱신 → 화면 반영. 이동·구독은 호출자의 `open(id)`이 기존 규칙으로 한다. */
  const refreshThen = async (id: string, arrived = true): Promise<string> => {
    // 생성·참여·DM은 이미 성공했다 — 목록 조회 실패를 동작 실패로 돌려주면 재제출이 409가 된다(Codex r1 P2).
    // 목록은 다음 복귀 절차가 다시 읽는다. 401은 api가 세션을 이미 끝냈다.
    opening = id;
    // 동작 성공 시점까지 발급한 순번 — 이후 시작되는 조회(아래 재조회 포함)만 이 대화의 목록 반영을 확정할 수 있다.
    const succeededAt = listRequests;
    try {
      await loadList();
    } catch (e) {
      if (!(e instanceof NetworkError) && !(e instanceof HttpStatusError)) throw e;
      // 도착한 대화가 목록에서 아직 확인되지 않았다 — 화면이 「없음」으로 오진하지 않게 알린다(Codex r3 P2).
      // 동작 뒤에 시작된 다른 성공 조회가 이미 반영됐으면 확정된 상태다 — 늦은 실패가 pending을 되살리지 않는다(PR 28 Codex r4 P2).
      if (arrived && !ended && listApplied <= succeededAt) unlisted = new Map(unlisted).set(id, succeededAt);
    } finally {
      opening = null;
    }
    if (!ended) emit();
    return id;
  };

  return {
    getSnapshot: () => snapshot,
    createChannel: (name) =>
      attempt(async () => refreshThen((await api.post<ConversationRef>('/api/conversations', { kind: 'channel', name })).id)),
    discoverChannels: () =>
      attempt(async () => {
        let page = await api.get<DiscoverResponse>('/api/conversations/discover');
        const all = [...page.channels];
        while (page.next_cursor !== null) {
          page = await api.get<DiscoverResponse>(`/api/conversations/discover?after=${encodeURIComponent(page.next_cursor)}`);
          all.push(...page.channels);
        }
        return all;
      }),
    joinChannel: (conversationId) =>
      attempt(async () => {
        let ref: ConversationRef;
        try {
          ref = await api.post<ConversationRef>(`/api/conversations/${encodeURIComponent(conversationId)}/join`);
        } catch (e) {
          // 나가 있는 동안 삭제된 채널(404 — 서버 join 404는 없는 ID·삭제·DM뿐): 확정 삭제로 정리하고 실패를 돌려준다(agy r2).
          if (e instanceof HttpStatusError && e.status === 404) forgetConversation(conversationId);
          throw e;
        }
        const next = new Map(leftChannels);
        next.delete(conversationId);
        leftChannels = next;
        // 재참여 성공 = 살아 있는 채널: 삭제 기억이 남아 있어도 목록·열기를 막지 않게 지운다(방어, Aside r3).
        if (deleted.has(conversationId)) deleted = new Set([...deleted].filter((d) => d !== conversationId));
        return refreshThen(ref.id);
      }),
    leaveChannel: (conversationId) =>
      attempt(async () => {
        await api.del<undefined>(`/api/conversations/${encodeURIComponent(conversationId)}/membership`);
        const space = spaces.find((sp) => sp.id === conversationId);
        if (space !== undefined) leftChannels = new Map(leftChannels).set(conversationId, { ...space, left: true, unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 });
        // 구독 해제: 현재 대화면 내린다 — 다시 참여 후 `open(id)`이 이력·구독을 다시 연다.
        if (current === conversationId) {
          realtime.send({ type: 'conversation.unsubscribe', conversation_id: conversationId });
          acks.get(conversationId)?.reject(new Error('left'));
          acks.delete(conversationId);
          current = null;
        }
        if (openRoot?.conversationId === conversationId) openRoot = null;
        // 목록 재조회가 실패해도 나간 상태는 바로 보인다(Codex r1 P2).
        spaces = withLeft(spaces.filter((sp) => sp.id !== conversationId));
        emit();
        await refreshThen(conversationId, false);
        return null;
      }),
    deleteChannel: (conversationId) =>
      attempt(async () => {
        await api.del<undefined>(`/api/conversations/${encodeURIComponent(conversationId)}`);
        if (current === conversationId) realtime.send({ type: 'conversation.unsubscribe', conversation_id: conversationId });
        forgetConversation(conversationId);
        return null;
      }),
    listConversationMembers: (conversationId) =>
      attempt(async () => {
        const res = await api.get<ConversationMembersResponse>(`/api/conversations/${encodeURIComponent(conversationId)}/members`);
        return res.members.map((m) => ({ id: m.id, displayName: m.display_name, ...(bots.has(m.id) ? { bot: true } : {}) }));
      }),
    addBotToChannel: (conversationId, botUserId) =>
      attempt(async () => {
        await api.post<unknown>(`/api/conversations/${encodeURIComponent(conversationId)}/bots`, { bot_user_id: botUserId });
        return null;
      }),
    removeBotFromChannel: (conversationId, botUserId) =>
      attempt(async () => {
        await api.del<undefined>(`/api/conversations/${encodeURIComponent(conversationId)}/bots/${encodeURIComponent(botUserId)}`);
        return null;
      }),
    listMembers: () =>
      attempt(async () => {
        const res = await api.get<MembersResponse>('/api/members');
        learnActive(res.members);
        noteKinds(res.members);
        noteActive(res.members);
        return res.members.map((m) => ({ id: m.id, displayName: m.display_name, role: m.role, kind: m.kind }));
      }),
    createInvite: () =>
      attempt(async () => {
        const res = await api.post<{ id: string; token: string; expires_at: string }>('/api/invites');
        return { id: res.id, token: res.token, expiresAt: res.expires_at };
      }),
    deactivateMember: (userId) =>
      attempt(async () => {
        await api.post<undefined>(`/api/admin/members/${encodeURIComponent(userId)}/deactivate`);
        // 멤버 관리는 성공 뒤 목록을 다시 읽지 않는다 — 여기서 바로 활성에서 빼야 멘션 후보·이름이 맞는다(QA D1).
        activeIds = new Set([...activeIds].filter((id) => id !== userId));
        noteGone([userId]);
        return null;
      }),
    listSessions: () =>
      attempt(async () => {
        const res = await api.get<SessionsResponse>('/api/sessions');
        return res.sessions.map((x) => ({ id: x.id, deviceLabel: x.device_label, createdAt: x.created_at, lastSeenAt: x.last_seen_at, current: x.current }));
      }),
    revokeSession: (sessionId) =>
      attempt(async () => {
        await api.del<undefined>(`/api/sessions/${encodeURIComponent(sessionId)}`);
        return null;
      }),
    startDm: (userId) => attempt(async () => refreshThen((await api.post<ConversationRef>('/api/dms', { user_id: userId })).id)),
    reload: () => {
      if (listState === 'error') {
        listState = 'loading';
        emit();
      }
      void resume('manual');
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onConversationDeleted(listener) {
      deletedListeners.add(listener);
      return () => {
        deletedListeners.delete(listener);
      };
    },
    send(target, body, mentionUserIds, attachmentIds) {
      nextRoot = target.rootId;
      nextMentions = mentionUserIds;
      nextAttachments = attachmentIds;
      void sendController.submit(target.conversationId, body);
      nextRoot = undefined;
      nextMentions = undefined;
      nextAttachments = undefined;
    },
    /** Web Push 구독(W-23, TRD §6-2). 키 404 = push 비활성 → null. 오류는 그대로 던진다(CMP-30 「등록 실패」). */
    push: {
      async vapidPublicKey() {
        try {
          return vapidPublicKeyResponseSchema.parse(await api.get('/api/push/vapid-public-key')).public_key;
        } catch (e) {
          if (e instanceof HttpStatusError && e.status === 404) return null;
          throw e;
        }
      },
      async register(subscription) {
        const body = pushSubscriptionCreateSchema.parse(subscription);
        return pushSubscriptionCreatedSchema.parse(await api.post('/api/push/subscriptions', body)).subscription.id;
      },
      async unregister(id) {
        await api.del(`/api/push/subscriptions/${encodeURIComponent(id)}`);
      },
    },
    uploadAttachment(conversationId, file, options = {}) {
      return attempt(async () => {
        const headers = options.filename === undefined ? undefined : { [ATTACHMENT_FILENAME_HEADER]: encodeURIComponent(options.filename) };
        const res = await api.upload<AttachmentUploadResponse>(
          `/api/attachments?conversation_id=${encodeURIComponent(conversationId)}`,
          file,
          options.type ?? file.type,
          { ...(headers === undefined ? {} : { headers }), ...(options.signal === undefined ? {} : { signal: options.signal }) },
        );
        return res.attachment;
      });
    },
    open(conversationId) {
      if (ended || conversationId === current) return;
      // 이전 대화는 참여 중이면 배경 구독으로 남기고(BRIEF ★2), 아니면 구독을 푼다.
      const prev = current;
      const keep = prev !== null && connection === 'connected' && summaries.some((c) => c.id === prev) && !leftChannels.has(prev);
      if (keep) background = new Set(background).add(prev);
      else if (prev !== null) realtime.send({ type: 'conversation.unsubscribe', conversation_id: prev });
      // 나간 채널은 구독·이력을 열지 않는다(구독은 서버가 거절한다) — 다시 참여 뒤 `open(id)`이 연다.
      current = conversationId !== null && (leftChannels.has(conversationId) || deleted.has(conversationId)) ? null : conversationId;
      // 대화 전환: 보류 스레드 위치와 재시도 백오프를 초기화한다(Codex r1 P2-1·3).
      deferredThreadReads = new Map();
      repliesLoaded = new Set();
      // 지난 대화의 스레드·진행 중 답글 조회는 버린다(agy r3 #2). 새 스레드는 이 뒤 `openThread`가 연다.
      repliesEpoch += 1;
      openRoot = null;
      readFailures = 0;
      loadedHistory = null;
      // 배경 구독 중이었어도 현재 대화는 기존 절차(ACK 구독)로 다시 구독한다(BRIEF ★2 현재 대화 절차 불변).
      if (current !== null && background.has(current)) background = new Set([...background].filter((b) => b !== current));
      if (current === null || conversationId === null) return;
      void loadHistory(conversationId);
      if (!resuming && checkpoint !== null) {
        subscribe(conversationId, checkpoint).catch((e: unknown) => {
          if (e instanceof SubscribeRejected && e.code === 'not_found' && !ended) void release(conversationId).catch(() => undefined);
        });
      }
    },
    markRead,
    openThread(rootId) {
      if (ended) return;
      openRoot = rootId === null ? null : { conversationId: current, rootId };
      if (rootId === null) return;
      void loadReplies(rootId);
    },
    start() {
      stopped = false;
      const life = deps.lifecycle;
      // 계측 주기·이탈 전송(기본 버퍼일 때만). 다시 `start()`하면 이전 배선을 먼저 푼다.
      stopMetrics();
      stopMetrics = metricsBuffer?.start(life) ?? (() => undefined);
      if (life !== undefined) {
        // 전경 복귀는 WS가 살아 있어도 항상 catch-up(UI_STATES C8, DD R-03) — 5분 이상 백그라운드 복귀를 포함한다.
        const onVisible = () => {
          if (life.doc.visibilityState === 'visible') void resume('foreground');
          // 전경에서 본 위치는 전경 이탈 즉시 보낸다(대기분 손실 방지, BRIEF ★1).
          else flushReads();
        };
        const onOnline = () => {
          void resume('foreground');
          // 오프라인으로 못 보낸 메시지는 복귀 때 같은 ID로 한 번 다시 보낸다(2026-11-17 결정, UI_STATES §2-5).
          if (!ended) void sendController.resendOffline();
        };
        const onOffline = () => setConnection('offline');
        life.doc.addEventListener('visibilitychange', onVisible);
        life.win.addEventListener('online', onOnline);
        life.win.addEventListener('offline', onOffline);
        detach = () => {
          life.doc.removeEventListener('visibilitychange', onVisible);
          life.win.removeEventListener('online', onOnline);
          life.win.removeEventListener('offline', onOffline);
        };
      }
      return resume();
    },
    resume,
    editMessage: (messageId, body) =>
      attempt(async () => {
        const res = parseWriteResponse(await api.patch<unknown>(`/api/messages/${encodeURIComponent(messageId)}`, { body }));
        if (!ended) {
          fold = foldView(res.change_id, res.message);
          emit();
        }
        return null;
      }),
    deleteMessage: (messageId) =>
      attempt(async () => {
        const res = await api.del<MessageDeleteResponse>(`/api/messages/${encodeURIComponent(messageId)}`);
        if (!ended) {
          fold = foldDeleted(fold, res);
          emit();
        }
        return null;
      }),
    retry: (clientMessageId) => sendController.retry(clientMessageId),
    discard: (clientMessageId) => sendController.discard(clientMessageId),
    async logout() {
      try {
        await api.post('/api/auth/logout');
      } finally {
        end('logout');
      }
    },
    stop() {
      stopped = true;
      if (readTimer !== null) clearTimer(readTimer);
      if (reloadTimer !== null) clearTimer(reloadTimer);
      readTimer = null;
      readTimerIsRetry = false;
      reloadTimer = null;
      detach();
      stopMetrics();
      generation += 1;
      realtime.stop();
    },
  };
}

/** sync_result dims(구간값만, PRD §10). 구간 밖 값은 allowlist 검증에서 버려진다. */
function syncDims(trigger: SyncTrigger, outcome: SyncOutcome, changes: number, ms: number): MetricDims {
  return { trigger, outcome, caught_up_count: bucketCount(changes), duration_ms: bucketDurationMs(ms) };
}
