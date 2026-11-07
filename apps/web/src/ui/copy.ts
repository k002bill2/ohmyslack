/**
 * 화면 문구 단일 모듈 — 정본: `docs/07-ui-spec/UI_STATES.md` §9 채택분(`COPY_GAPS.md` G-n 확정안).
 * 컴포넌트는 여기 상수만 참조한다. 보류 항목(G-16 macOS 분기 문장, G-18 최종 이름, G-38 heartbeat)은 두지 않는다.
 */

/** 한국어 천 단위 구분(「4,000」 형식). */
const fmt = (n: number): string => n.toLocaleString('ko-KR');

/** G-17 임시 앱 이름(manifest `name`·`short_name`, `<title>`, apple meta). */
export const APP_NAME = '메신저';

/** 공통 행동 버튼(D §6-1, G-02·G-03·G-11·G-12·G-19·G-35). */
export const RETRY_LABEL = '다시 시도';

/** CMP-19 로그인(G-01–G-05). */
export const LOGIN_COPY = {
  title: '로그인',
  intro: '초대받은 계정의 이메일과 비밀번호를 입력해 주세요.',
  credentials: '로그인할 수 없습니다. 이메일과 비밀번호를 확인해 주세요.',
  network: '서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.',
  server: '서버에 문제가 생겨 로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  invalidRequest: '입력 형식을 처리할 수 없습니다. 이메일 주소를 확인해 주세요.',
} as const;

/** CMP-19 초대 수락(G-06–G-13). */
export const INVITE_COPY = {
  title: '초대 수락',
  intro: '계정을 만들면 바로 참여할 수 있습니다. 이메일·비밀번호·표시 이름을 입력해 주세요.',
  displayNameLabel: '표시 이름',
  displayNameHint: '다른 멤버에게 보이는 이름입니다. 64자까지 입력할 수 있습니다.',
  passwordHint: '12자 이상 128자 이하로 입력해 주세요.',
  passwordPolicy: '비밀번호 길이가 맞지 않습니다. 12자 이상 128자 이하로 입력해 주세요.',
  invalidRequest: '입력 내용을 처리할 수 없습니다. 이메일 형식과 표시 이름(1–64자)을 확인해 주세요.',
  network: '서버에 연결하지 못했습니다. 입력한 내용은 그대로 있으니 다시 시도해 주세요.',
  server: '서버에 문제가 생겨 초대를 수락하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  /** G-13(권장안): 정본 「이 초대 링크는 더 이상 사용할 수 없습니다」 아래 보조 안내 + 링크. */
  unusableHint: '이미 계정을 만들었다면 로그인해 주세요.',
  loginLink: '로그인',
} as const;

/** G-13 링크 대상(D §4-2 `/login`). */
export const LOGIN_PATH = '/login';

/** CMP-20 InstallHint(G-14·G-15). G-16 macOS 분기는 보류라 두지 않는다. */
export const INSTALL_COPY = {
  button: '앱으로 설치',
  ios: 'Safari의 공유 메뉴에서 「홈 화면에 추가」를 누르면 앱처럼 쓸 수 있습니다.',
} as const;

/** CMP-17 ErrorState 원인 1문장(G-19). */
export const ERROR_COPY = {
  network: '서버에 연결하지 못했습니다.',
  timeout: '서버 응답이 늦어 확인하지 못했습니다.',
  server: '서버에 문제가 생겨 처리하지 못했습니다.',
  rateLimited: '요청이 많아 잠시 처리할 수 없습니다.',
  badRequest: '입력 내용을 처리할 수 없습니다. 내용을 확인해 주세요.',
  notFound: '찾을 수 없거나 볼 수 없는 항목입니다. 목록을 새로 고쳐 주세요.',
  refreshList: '목록 새로 고침',
} as const;

/** CMP-07 전송 상태(G-20·G-34·G-35). 접근 이름은 정본 문구(D §6-3)를 그대로 쓴다. */
export const MESSAGE_STATUS_COPY = {
  unknownLabel: '저장 여부 확인 중',
  unknownRetryName: '저장 여부 확인 중 · 다시 시도',
  unknownDiscard: '목록에서 지우기',
  failedLabel: '전송 실패',
  failedRetryName: '전송 실패 · 다시 시도',
  rewriteInvalid: '보낼 수 없는 내용입니다. 내용을 고쳐 다시 작성해 주세요.',
  rewriteConflict: '같은 메시지가 다른 내용으로 이미 처리되었습니다. 새로 다시 작성해 주세요.',
} as const;

/** CMP-11 Composer(G-28·G-29·G-30). */
export const COMPOSER_COPY = {
  messagePlaceholder: '메시지 입력',
  replyPlaceholder: '답글 입력',
  replyLabel: '답글 작성',
  limit: '4,000자까지 입력할 수 있습니다',
} as const;

/** G-29 본문 작성기 접근 이름(예: 「#공지에 메시지 작성」). */
export const messageComposerLabel = (spaceTitle: string): string => `${spaceTitle}에 메시지 작성`;
/** G-30 3,800–4,000 카운터. */
export const remainingText = (remaining: number): string => `${fmt(remaining)}자 남음`;
/** G-30 4,000 초과 카운터. */
export const overText = (over: number): string => `${fmt(over)}자 초과`;

/** CMP-13 스레드 빈 상태(G-22). */
export const THREAD_EMPTY_TEXT = '첫 답글을 남겨 보세요';

/** CMP-12 멘션 후보 결과 없음(G-21). 컴포넌트 미구현 — 상수만. */
export const MENTION_EMPTY_TEXT = '일치하는 참여자가 없습니다';

/** CMP-04 배지 접근 이름(G-32). 99 초과는 「멘션 99개 이상」. */
export const mentionCountLabel = (count: number, cap: number): string =>
  count > cap ? `멘션 ${cap}개 이상` : `멘션 ${count}개`;

/** G-36 접힌 사이드바 항목 이름 구분자(쉼표+공백). */
export const COLLAPSED_LABEL_SEPARATOR = ', ';

/** CMP-02 사이드바 토글(G-31). 토글 컴포넌트 미구현 — 상수만. */
export const SIDEBAR_TOGGLE_COPY = { collapse: '사이드바 접기', expand: '사이드바 펼치기' } as const;

/** CMP-18 Dialog 제목(G-26) 및 확인 Dialog(G-23·G-24·G-25·G-27). Dialog 미구현 — 상수만. */
export const DIALOG_TITLES = {
  createChannel: '채널 만들기',
  browseChannels: '채널 찾기',
  startDm: 'DM 시작',
  createInvite: '초대 링크 만들기',
  leaveChannel: '채널 나가기',
  deactivateMember: '멤버 비활성화',
  deleteMessage: '메시지 삭제',
  shortcuts: '키보드 단축키',
} as const;

export const CANCEL_LABEL = '취소';

export const LEAVE_CHANNEL_COPY = {
  title: DIALOG_TITLES.leaveChannel,
  body: '나가면 이 채널의 새 메시지를 받지 않습니다. 다시 참여하면 이력을 볼 수 있습니다.',
  confirm: '나가기',
} as const;

export const DELETE_MESSAGE_COPY = {
  title: DIALOG_TITLES.deleteMessage,
  body: '삭제하면 모든 참여자에게 「삭제된 메시지입니다」로 보이며 되돌릴 수 없습니다.',
  confirm: '삭제',
} as const;

export const CHANNEL_NAME_TAKEN_TEXT = '같은 이름의 채널이 이미 있습니다. 다른 이름을 입력해 주세요.';

/** CMP-25 MemberAdmin(G-27): 행 버튼 「비활성화」, Dialog 제목·확인 버튼 「멤버 비활성화」. */
export const MEMBER_DEACTIVATE_COPY = {
  rowButton: '비활성화',
  rowButtonName: (name: string): string => `${name} 비활성화`,
  confirm: DIALOG_TITLES.deactivateMember,
} as const;

/**
 * CMP-25 MemberAdmin 화면·초대 발급 Dialog(W-10h). 모두 정본 문구 그대로:
 * title = D §4-2 표·UI_STATES §3 표 「멤버 관리」, inviteWarning = UI_STATES §2-8·§2-12 / D §10-2 S1,
 * expiresLabel = UI_STATES §2-12 「만료 시각」, copy = UI_STATES §2-12 「가능한 동작: 복사」,
 * deactivateBody = D §4-3 용어표·UI_STATES §2-8, inactive = UI_STATES §2-12 「비활성」 라벨,
 * roles = D §4-2 「(관리자)」·UI_STATES §6-1 「A=관리자, B=멤버」.
 */
export const MEMBER_ADMIN_COPY = {
  title: '멤버 관리',
  createInvite: DIALOG_TITLES.createInvite,
  inviteWarning: '이 창을 닫으면 다시 볼 수 없습니다',
  expiresLabel: '만료 시각',
  copy: '복사',
  deactivateBody: '이 멤버의 모든 기기가 5초 안에 로그아웃되며 다시 로그인할 수 없습니다',
  inactive: '비활성',
  roles: { owner: '관리자', member: '멤버' },
} as const;

/** 공간 전환기(G-33). 컴포넌트 미구현 — 상수만. */
export const SPACE_SWITCHER_COPY = {
  title: '공간 이동',
  inputLabel: '채널 또는 DM 이름',
  empty: '일치하는 채널이나 DM이 없습니다',
} as const;

/** CMP-18 Dialog 닫기 버튼(D §6 아이콘 표 「닫기 / 뒤로」 `x`, UI_STATES §2-8 「Esc·닫기(`x`)」). 아이콘 없이 텍스트로. */
export const DIALOG_CLOSE_LABEL = '닫기';

/** CMP-02 Sidebar(UI_STATES §2-3, D §6-2 CMP-02 버튼명·§10-1 SCR-03, D §4-2 설정 「로그아웃」). */
export const SIDEBAR_COPY = {
  browseChannels: DIALOG_TITLES.browseChannels,
  startDm: DIALOG_TITLES.startDm,
  createChannel: DIALOG_TITLES.createChannel,
  emptyOwner: '첫 채널을 만들어 보세요',
  emptyMember: '채널이 없습니다 — 관리자만 생성',
  logout: '로그아웃',
} as const;

/** CMP-23 ChannelBrowser(UI_STATES §2-11, D §6-2 CMP-23). */
export const CHANNEL_BROWSER_COPY = {
  empty: '참여할 수 있는 채널이 없습니다',
  join: '참여',
} as const;

/** CMP-24 DmStarter(UI_STATES §2-11). 시작 버튼은 「DM 시작」(같은 표 기본 상태). */
export const DM_STARTER_COPY = {
  empty: '다른 멤버가 없습니다',
  start: DIALOG_TITLES.startDm,
} as const;

/** 서버 403(D §4-2 멤버 관리 「권한이 없습니다」, UI_STATES §2-12 권한 없음). 채널 만들기 403에도 같은 문장을 쓴다. */
export const FORBIDDEN_TEXT = '권한이 없습니다';

/** 나간 채널(UI_STATES §2-3 SpaceListItem·§2-5 ConversationHeader·MessageList 「나간 채널」 행 문구 그대로, W-10j). */
export const LEFT_CHANNEL_COPY = {
  leave: DIALOG_TITLES.leaveChannel,
  rejoinRow: '나간 채널 · 다시 참여',
  rejoin: '다시 참여',
  notice: '이 채널을 나갔습니다. 다시 참여하면 이력을 볼 수 있습니다',
  join: '참여',
} as const;
