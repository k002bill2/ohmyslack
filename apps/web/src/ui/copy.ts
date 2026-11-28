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
  /** G-05 개정(시안 R5, 2026-11-15). */
  intro: '본인 기기에서만 접속하는 개인 메신저입니다.',
  /** G-73 카드 아래 안내(시안 R5). 가입 경로가 초대뿐임을 알린다(T §5). */
  inviteOnly: '계정은 관리자가 보낸 초대 링크로만 만들 수 있습니다.',
  emailPlaceholder: 'name@example.com',
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
  timeout: '처리 결과를 확인하지 못했습니다.',
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
  /** R4 시안 작성기 아래 줄 `@` 아이콘 버튼 접근 이름 — 커서 위치에 `@`를 넣어 멘션 후보를 연다. */
  mentionButton: '멘션 추가',
  /** G-52: 상대가 비활성화된 DM — 본문·답글 작성기 자리 안내(서버는 이 DM 쓰기를 403으로 거절). */
  inactivePeer: '비활성화된 멤버라 메시지를 보낼 수 없습니다',
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

/** CMP-02 사이드바 토글(G-31). Sidebar 헤더·레일 토글이 사용(정본). */
export const SIDEBAR_TOGGLE_COPY = { collapse: '사이드바 접기', expand: '사이드바 펼치기' } as const;

/** CMP-18 Dialog 제목(G-26) 및 확인 Dialog(G-23·G-24·G-25·G-27). Dialog 미구현 — 상수만. */
export const DIALOG_TITLES = {
  createChannel: '채널 만들기',
  browseChannels: '채널 찾기',
  startDm: 'DM 시작',
  createInvite: '초대 링크 만들기',
  leaveChannel: '채널 나가기',
  deleteChannel: '채널 삭제',
  deactivateMember: '멤버 비활성화',
  deleteMessage: '메시지 삭제',
  shortcuts: '키보드 단축키',
  notifications: '알림',
} as const;

export const CANCEL_LABEL = '취소';

export const LEAVE_CHANNEL_COPY = {
  title: DIALOG_TITLES.leaveChannel,
  body: '나가면 이 채널의 새 메시지를 받지 않습니다. 다시 참여하면 이력을 볼 수 있습니다.',
  confirm: '나가기',
} as const;

/** 채널 삭제 확인 Dialog(FR-CONV-06, COPY_GAPS G-23b): owner 전용, 나가기 Dialog와 같은 CMP-18 패턴. */
export const DELETE_CHANNEL_COPY = {
  title: DIALOG_TITLES.deleteChannel,
  body: (name: string) => `#${name} 채널을 삭제하면 모든 멤버가 이 채널과 메시지를 더 이상 볼 수 없습니다. 앱에서 되돌릴 수 없습니다.`,
  confirm: '삭제',
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
  /** 새 시안 Admin-Members 목록 머리: 인원 + 초대 링크 규칙 안내. */
  count: (n: number) => `멤버 ${n}명`,
  inviteRule: '초대 링크는 한 번만 쓸 수 있고 만료 시각이 지나면 사용할 수 없습니다.',
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
 * R4 시안 메시지 툴바·메뉴(Floating-Menus A·B). 메뉴는 「더보기」 버튼·우클릭·Shift+F10으로 연다.
 * 수정·삭제는 내 메시지에만, 삭제는 확인 Dialog(DELETE_MESSAGE_COPY)를 거친다.
 */
export const MESSAGE_MENU_COPY = {
  menu: '메시지 메뉴',
  more: '더보기',
  reply: '답글',
  replyInThread: '스레드로 답글',
  copyText: '텍스트 복사',
  copyLink: '메시지 링크 복사',
  edit: '메시지 수정',
  delete: '메시지 삭제…',
  copiedText: '텍스트를 복사했습니다',
  copiedLink: '링크를 복사했습니다',
  copyFailed: '복사하지 못했습니다',
} as const;

/** 메시지 본문 코드 블록 복사 아이콘 버튼(CMP-08): 접근 이름·툴팁 `label`, 성공 낭독 `copied`. 실패 낭독은 MESSAGE_MENU_COPY.copyFailed. */
export const CODE_BLOCK_COPY = {
  label: '코드 복사',
  copied: '복사됨',
} as const;

/** R4 시안 대화 헤더 더보기 메뉴(Floating-Menus D). 「멤버 보기」는 채널 멤버 화면이 없어 아직 렌더하지 않는다. */
export const HEADER_MENU_COPY = {
  more: '대화 더보기',
  menu: '대화 메뉴',
  shortcuts: '키보드 단축키',
  /** G-74: Jarvis DM 헤더 더보기 → 알림 설정 Dialog(본문 위 안내 배너 대체). */
  notifications: '알림 설정…',
  leave: '채널 나가기…',
  deleteChannel: '채널 삭제…',
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

/** 알림 탭 위치 복원(W-23 Codex P2-3): 대상 메시지가 불러온 범위에 없을 때 짧은 안내. */
export const MESSAGE_ANCHOR_COPY = {
  notFound: '메시지를 찾을 수 없습니다',
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
 * 채널 헤더 봇 컨트롤(FR-BOT-11, COPY_GAPS G-43–47). ★ Jarvis 초안(2026-11-10), 영환님 사후 조정 가능.
 * 구조는 「채널 나가기」(`LEFT_CHANNEL_COPY`·`LEAVE_CHANNEL_COPY`)와 같다: 헤더 버튼 = Dialog 제목, 확인 버튼은 동사 하나.
 * 봇이 여럿일 수 있어 버튼·제목에 봇 이름을 붙인다(조사 없이 「: 이름」).
 */
export const BOT_CHANNEL_COPY = {
  /** G-43 추가 버튼. */
  add: (bot: string) => `봇 추가: ${bot}`,
  /** G-44 제거 버튼 겸 확인 Dialog 제목. */
  title: (bot: string) => `봇 제거: ${bot}`,
  /** G-45 확인 Dialog 본문. */
  body: '제거하면 이 봇은 이 채널의 새 메시지를 받지 않고 이 채널에 글을 쓸 수 없습니다. 다시 추가할 수 있습니다.',
  /** G-46 확인 버튼(취소는 `CANCEL_LABEL`). */
  confirm: '제거',
  /** G-47 추가 실패 — 뒤에 원인 1문장(`failureText`)을 붙인다. */
  addFailed: '봇을 추가하지 못했습니다.',
  /** G-79 시간 초과(결과 미확인) — 단정 접두 대신 이 한 문장만. */
  addUnconfirmed: '봇 추가 결과를 확인하지 못했습니다.',
} as const;

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
  /** 파일 선택 버튼 접근 이름(G-53 — 이미지·문서를 한 버튼으로). */
  attach: '파일 첨부',
  remove: '첨부 제거',
  uploading: '업로드 중',
  tooLarge: '파일이 너무 큽니다(최대 10MB)',
  /** 문서·텍스트 크기 초과(G-55). 서버 413만 오고 형식을 모르면 이 문구. */
  docTooLarge: '파일이 너무 큽니다(최대 25MB)',
  /** 허용 형식 안내(G-54 + 텍스트 계열 3종, TRD §6-1-1 R3.6). 415 `macro_extension_mismatch` 외 모든 415·사전 거부. */
  unsupported: '지원하지 않는 형식입니다(이미지 PNG·JPEG·WebP, 문서 PDF·Word·Excel·PowerPoint·한글, 텍스트 TXT·MD·CSV)',
  /** 415 `macro_extension_mismatch`(G-56). */
  macroExtension: '매크로가 들어 있는 문서입니다. .docm·.xlsm·.pptm 확장자로 저장해 다시 보내 주세요.',
  /** 네트워크·5xx 실패(G-57) — 뒤에 원인 1문장(`failureText`)을 붙인다. */
  uploadFailed: '업로드하지 못했습니다.',
  /** G-79 시간 초과(결과 미확인) — 단정 접두 대신 이 한 문장만. */
  uploadUnconfirmed: '업로드 결과를 확인하지 못했습니다.',
  /** 본문 없이 이미지만 보낼 때 채우는 본문(서버는 첨부 메시지도 본문 필수). */
  imageOnlyBody: '[이미지]',
  /** 본문 없이 문서만 보낼 때(G-58). 섞이면 첫 첨부의 형식 문구. */
  documentOnlyBody: '[문서]',
  /** 「매크로 포함」 표지(G-60). */
  macros: '매크로 포함',
  /** 문서 행 받기 버튼 보이는 텍스트(G-62). 접근 이름은 `documentDownloadName`. */
  download: '받기',
} as const;

/** 문서 형식 표지 텍스트(G-59). 키는 `file-kinds.ts`가 서버 판정 mime으로 고른다. */
export const DOCUMENT_KIND_COPY = {
  pdf: 'PDF',
  word: 'Word',
  excel: 'Excel',
  powerpoint: 'PowerPoint',
  hwp: '한글',
  txt: 'TXT',
  md: 'MD',
  csv: 'CSV',
} as const;
export type DocumentKind = keyof typeof DOCUMENT_KIND_COPY;

/** 「받기」 접근 이름(G-62): 「{전체 파일명} 받기, {형식}, {크기}」 + 매크로면 「, 매크로 포함」. */
export function documentDownloadName(filename: string, kind: string, size: string, hasMacros: boolean): string {
  const base = `${filename} ${ATTACHMENT_COPY.download}, ${kind}, ${size}`;
  return hasMacros ? `${base}, ${ATTACHMENT_COPY.macros}` : base;
}

/**
 * Web Push 알림 고정 문구(W-23, TRD §6-2). 정본 미정(UI_STATES §8 Q-H5) — Jarvis ★ 임시 결정.
 * 서비스 워커가 쓴다 — 제목은 항상 이 문구, 본문은 세션으로 가져온 미리보기가 없을 때의 폴백이다(R3.9). 대화 이름·작성자 이름은 표시하지 않는다.
 */
export const PUSH_NOTIFICATION_COPY = {
  title: 'ohmyslack',
  botTitle: 'Jarvis',
  body: '새 메시지가 있습니다',
} as const;

/** 환경설정 Dialog(사이드바 계정 영역 설정 아이콘, 2026-11-23 영환님 지시). 섹션 이름은 `sections`에 하나씩 추가한다. */
export const PREFERENCES_COPY = {
  title: '환경설정',
  open: '환경설정',
  sectionsLabel: '설정 항목',
  sections: {
    notifications: '알림',
  },
  notificationsDescription: '이 기기에서 받을 알림을 켜거나 끕니다.',
} as const;

/**
 * CMP-30 PushSettings 문구(W-23). 정본 미정(UI_STATES §8 Q-H4) — Jarvis ★ 임시 결정.
 * 위치: 사이드바 계정 영역 + Jarvis DM 헤더 더보기 「알림 설정…」 Dialog(G-74, 2026-11-16 — 본문 위 배너 폐지).
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
} as const;

/**
 * 작성자·DM 상대 이름 대체 표기(G-50·G-51). 비활성 멤버는 이름 뒤에 「(비활성)」, 끝내 이름을 모르면 「알 수 없는 사용자」.
 * 화면에 빈 이름이나 UUID를 내지 않는다(W-10k A).
 */
const INACTIVE_SUFFIX = '(비활성)';
export const AUTHOR_NAME_COPY = {
  inactive: (name: string): string => `${name} ${INACTIVE_SUFFIX}`,
  /** 화면에서 이름과 접미를 따로 그릴 때의 접미(QA D2·D3). `inactive`와 같은 정본 문구. */
  inactiveSuffix: INACTIVE_SUFFIX,
  unknown: '알 수 없는 사용자',
} as const;

/**
 * CMP-22 SessionList 「로그인한 기기」(W-30, UI_STATES §2-14, COPY_GAPS G-63–G-72 ★ Designer 초안).
 * 목록 오류·시간 초과·대상 없음은 `ERROR_COPY` 재사용(G-72·G-70), 「취소」는 `CANCEL_LABEL`.
 */
const SESSION_LIST_TITLE = '로그인한 기기';
export const SESSION_LIST_COPY = {
  /** G-63: 진입 버튼 이름 = 화면 제목 = 목록 `aria-label`. */
  title: SESSION_LIST_TITLE,
  /** G-64 이 기기 표지. */
  thisDevice: '이 기기',
  /** G-65 라벨 없음. */
  unknownDevice: '알 수 없는 기기',
  /** G-66 2줄째(`{시각}`은 오늘·어제 + 시각 / 그 전은 날짜만). */
  lastUsed: (when: string): string => `마지막 사용 ${when}`,
  /** G-65 같은 이름 행이 둘 이상이면 접근 이름 끝에 덧붙인다. */
  lastUsedSuffix: (when: string): string => `, 마지막 사용 ${when}`,
  /** G-67 다른 기기 행 버튼(보이는 글자)·접근 이름. */
  logout: '로그아웃',
  logoutName: (label: string): string => `${label} 로그아웃`,
  /** G-67 이 기기 행 버튼(확인 없이 기존 로그아웃). */
  logoutThisDevice: '이 기기에서 로그아웃',
  /** G-68 다른 기기 없음. */
  noOtherDevices: '다른 기기에서 로그인하지 않았습니다',
  /** G-69 확인 Dialog. */
  confirmTitle: '기기 로그아웃',
  confirmBody: (label: string): string =>
    `${label} 기기가 5초 안에 로그아웃되고 그 기기의 알림도 꺼집니다. 그 기기에서 다시 쓰려면 다시 로그인해야 합니다.`,
  confirm: '로그아웃',
  /** G-70 실패 첫 문장(뒤에 원인 1문장). */
  failed: '로그아웃하지 못했습니다.',
  /** G-79 시간 초과(결과 미확인) — 단정 접두 대신 이 한 문장만. */
  unconfirmed: '로그아웃 결과를 확인하지 못했습니다.',
  /** G-71 완료 알림(StatusRegion). */
  done: (label: string): string => `${label} 기기를 로그아웃했습니다`,
} as const;
