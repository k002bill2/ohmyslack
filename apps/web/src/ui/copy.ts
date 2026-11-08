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
  /** 답글 작성기 placeholder(시안 문구 채택, 결정 3). 접근 이름은 `replyLabel` 그대로. */
  replyPlaceholder: '답글 남기기',
  replyLabel: '답글 작성',
  limit: '4,000자까지 입력할 수 있습니다',
  /** 작성기 도움말(결정 3): wide·medium에서 작성기 아래 작게, compact는 렌더하지 않는다. */
  hint: 'Enter 전송 · Shift+Enter 줄바꿈 · 한글 조합 중 Enter는 무시',
} as const;

/** 본문 작성기 placeholder(결정 3): 채널 「#이름에 남기기」, DM 「상대 이름에게 남기기」. `name`에는 `#`이 없다. */
export const messagePlaceholder = (space: { readonly kind: 'channel' | 'dm'; readonly name: string }): string =>
  space.kind === 'channel' ? `#${space.name}에 남기기` : `${space.name}에게 남기기`;

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

/** CMP-12 멘션 팝오버 머리말·하단 도움말(결정 3). 머리말은 listbox 밖에 둔다. */
export const MENTION_POPOVER_COPY = {
  channelHeading: '이 채널의 멤버',
  dmHeading: '이 대화의 멤버',
  hint: '↑↓ 이동 · Enter 선택 · Esc 닫기',
} as const;

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

/**
 * SCR-09 단축키 안내(CMP-18 「키보드 단축키」) 행 — D §7-3 키맵 표의 키·동작 열 그대로.
 * 문서 상호 참조((§7-4 …)·(WCAG …))와 강조 표기만 뺐다. P1 후보 행(`↑` 내 마지막 메시지 수정)은 미구현이라 넣지 않는다.
 */
export const SHORTCUT_ROWS: readonly { readonly keys: string; readonly action: string }[] = Object.freeze([
  { keys: 'Ctrl/⌘+K', action: '공간 전환기(콤보박스) 열기 — 기본 전환 수단' },
  { keys: 'Ctrl+Alt+↑ / Ctrl+Alt+↓ (mac ⌃⌥↑/↓)', action: '이전/다음 공간' },
  { keys: 'Ctrl+Alt+Shift+↑ / ↓', action: '읽지 않은 공간만 이동' },
  { keys: 'Enter (작성기)', action: '전송' },
  { keys: 'Shift+Enter', action: '줄바꿈(조합 중이 아닐 때)' },
  { keys: 'Esc — 다이얼로그·멘션 후보·medium 스레드 오버레이·compact 스레드 화면 안', action: '항상 닫기. 작성기 초안은 대상별로 보존되어 다시 열면 복원' },
  { keys: 'Esc — wide 스레드 패널 작성기, 비어 있음', action: '스레드 패널 닫기' },
  { keys: 'Esc — wide 스레드 패널 작성기, 입력 있음', action: '1회: 아무 동작 없음 + "닫으려면 Esc를 한 번 더 누르세요"(초안은 보존됨) / 1.5초 안에 2회: 닫기' },
  { keys: 'Tab / Shift+Tab', action: '영역 간 이동. 메시지 목록 안에서는 메시지 단위(roving tabindex)' },
  { keys: '메시지에서 R / E / Delete', action: '답글 / 수정(내 것) / 삭제(내 것, 확인 다이얼로그)' },
  { keys: 'Ctrl/⌘+/', action: '키보드 단축키 안내 다이얼로그' },
]);

/** 공간 전환기(G-33). */
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

/**
 * CMP-07 메시지 액션·상태(W-10i). 모두 정본 문구 그대로:
 * edit·delete = D §3-4 아이콘 표 「수정 / 삭제」·§7-3 단축키 표 「수정(내 것) / 삭제(내 것)」,
 * edited = D §4-3 용어표·§6-3 「(수정됨)」, deleted = D §4-3·UI_STATES §2-5 「삭제된 메시지입니다」.
 */
export const MESSAGE_ACTION_COPY = {
  edit: '수정',
  delete: DELETE_MESSAGE_COPY.confirm,
  edited: '(수정됨)',
  deleted: '삭제된 메시지입니다',
} as const;

/**
 * CMP-14 ThreadSummary(UI_STATES §2-7, D §4-3 「답글 3」·「새 답글」). 「마지막 답글 n분 전」은 계약에 마지막 답글 시각이 없어
 * 렌더하지 않는다(W-10i REPORT).
 */
export const THREAD_SUMMARY_COPY = {
  replies: (count: number): string => `답글 ${count}`,
  newReplies: '새 답글',
} as const;

/** 시안 W-11b 대화 문구(결정 3으로 정본 채택 — `features/conversation/copy.ts`에서 이동, 값 그대로). */
export const CONVERSATION_DESIGN_COPY = {
  /** 시안 01 「나를 멘션」 라벨(CMP-07 멘션 강조). */
  mentionedSelf: '나를 멘션',
  /** UI_STATES §2-4 CMP-09. */
  newMessages: '여기부터 새 메시지',
  /** UI_STATES §2-4 CMP-10. */
  today: '오늘',
  yesterday: '어제',
  /** 시안 08 / UI_STATES §3 메시지 액션 — compact 액션 시트 제목·접근성 대체 버튼. */
  messageActions: '메시지 작업',
} as const;

/** 나간 채널(UI_STATES §2-3 SpaceListItem·§2-5 ConversationHeader·MessageList 「나간 채널」 행 문구 그대로, W-10j). */
export const LEFT_CHANNEL_COPY = {
  leave: DIALOG_TITLES.leaveChannel,
  rejoinRow: '나간 채널 · 다시 참여',
  rejoin: '다시 참여',
  notice: '이 채널을 나갔습니다. 다시 참여하면 이력을 볼 수 있습니다',
  join: '참여',
} as const;

/**
 * CMP-26 BotBadge 문구(W-19b). 정본 미정(UI_STATES §8 Q-H1) — Jarvis ★ 임시 결정: 작성자 이름 옆 텍스트 pill 「봇」.
 * 색만으로 구분하지 않고 접근 가능한 이름에 포함한다.
 */
export const BOT_BADGE_TEXT = '봇';

/**
 * 첨부 문구(W-22, CMP-27–29·Composer 첨부). 정본 미정(UI_STATES Q-H2·Q-H3) — Jarvis ★ 임시 결정.
 * 수치(10MB·형식)는 문구에만 쓰고 판정은 shared 상수(`ATTACHMENT_*`)와 서버 응답 코드가 한다.
 */
export const ATTACHMENT_COPY = {
  playbackFailed: '재생할 수 없습니다',
  retry: '다시 시도',
  expired: '만료된 첨부입니다',
  imageAlt: '첨부 이미지',
  /** 확대 Dialog 제목(CMP-18). */
  imageDialogTitle: '첨부 이미지',
  /** 파일 선택 버튼 접근 이름. */
  attach: '이미지 첨부',
  remove: '첨부 제거',
  uploading: '업로드 중',
  tooLarge: '파일이 너무 큽니다(최대 10MB)',
  unsupported: '지원하지 않는 형식입니다(PNG·JPEG·WebP)',
  uploadFailed: '업로드하지 못했습니다',
  /** 본문 없이 이미지만 보낼 때 채우는 본문(서버는 첨부 메시지도 본문 필수). */
  imageOnlyBody: '[이미지]',
} as const;

/**
 * Web Push 알림 고정 문구(W-23, TRD §6-2). 정본 미정(UI_STATES §8 Q-H5) — Jarvis ★ 임시 결정.
 * 서비스 워커가 쓴다 — 메시지 본문·대화 이름·작성자 이름은 표시하지 않는다.
 */
export const PUSH_NOTIFICATION_COPY = {
  title: 'ohmyslack',
  botTitle: 'Jarvis',
  body: '새 메시지가 있습니다',
} as const;

/**
 * CMP-30 PushSettings 문구(W-23). 정본 미정(UI_STATES §8 Q-H4) — Jarvis ★ 임시 결정.
 * 위치: 사이드바 계정 영역 + Jarvis DM 첫 진입 시 1회 안내(Q-H4 제안).
 */
export const PUSH_SETTINGS_COPY = {
  title: '알림',
  unsupported: '이 브라우저에서는 알림을 받을 수 없습니다.',
  iosInstall: '홈 화면에 추가하면 이 기기에서 알림을 받을 수 있습니다.',
  openInstallHint: '설치 안내 보기',
  enable: '알림 켜기',
  denied: '알림이 차단되어 있습니다. 시스템 설정에서 이 앱의 알림을 허용해 주세요.',
  subscribed: '이 기기에서 알림을 받는 중입니다.',
  disable: '끄기',
  failed: '알림을 등록하지 못했습니다.',
  retry: RETRY_LABEL,
  botHint: 'Jarvis의 새 메시지를 알림으로 받을 수 있습니다.',
  dismissHint: '닫기',
} as const;
