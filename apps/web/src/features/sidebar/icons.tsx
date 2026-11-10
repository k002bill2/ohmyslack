/**
 * W-11a 셸 아이콘(장식용, `aria-hidden`). 외부 아이콘 패키지·CDN 없이 직접 그린 단순 도형 — 색은 `currentColor`(토큰 글자색 상속).
 * 접근 이름은 항상 감싼 버튼·텍스트가 가진다.
 */
const BASE = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const;

/** 앱 심볼: 둥근 사각 안 두 개의 엇갈린 반원(시안 01 로고 자리 — 앱 이름·로고 확정 전 임시 도형). */
export function AppMark() {
  return (
    <svg {...BASE} className="app-mark-glyph">
      <path d="M5 9.5a3 3 0 0 1 3-5" />
      <path d="M11 6.5a3 3 0 0 1-3 5" />
    </svg>
  );
}

/** 스레드 패널 토글(시안 01 헤더 오른쪽): 사각형 + 오른쪽 세로 구획. */
export function PanelRightIcon() {
  return (
    <svg {...BASE}>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M10 2.5v11" />
    </svg>
  );
}

/** 검색(이동… 버튼, Lucide `search` 형태). */
export function SearchIcon() {
  return (
    <svg {...BASE}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m13.5 13.5-3.2-3.2" />
    </svg>
  );
}

/** 채널(Lucide `hash` 형태) — 「채널 찾기」. */
export function HashIcon() {
  return (
    <svg {...BASE}>
      <path d="M3 6h10M3 10h10M6.5 2.5 5 13.5M11 2.5l-1.5 11" />
    </svg>
  );
}

/** 대화(Lucide `message-square` 형태) — 「DM 시작」. */
export function MessageSquareIcon() {
  return (
    <svg {...BASE}>
      <path d="M13.5 10a1.5 1.5 0 0 1-1.5 1.5H5L2.5 14V3.5A1.5 1.5 0 0 1 4 2h8a1.5 1.5 0 0 1 1.5 1.5z" />
    </svg>
  );
}

/** 추가(Lucide `plus`) — 「채널 만들기」. */
export function PlusIcon() {
  return (
    <svg {...BASE}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

/** 설정(Lucide `settings` 단순형) — 「멤버 관리」. */
export function UsersIcon() {
  return (
    <svg {...BASE}>
      <circle cx="6" cy="5.5" r="2.5" />
      <path d="M1.5 13.5a4.5 4.5 0 0 1 9 0M11 3.2a2.5 2.5 0 0 1 0 4.6M12.5 9.6a4.5 4.5 0 0 1 2 3.9" />
    </svg>
  );
}

/** 로그아웃(Lucide `log-out`). */
export function LogOutIcon() {
  return (
    <svg {...BASE}>
      <path d="M6 13.5H3.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1H6M10.5 11 13.5 8l-3-3M13.5 8H6" />
    </svg>
  );
}

/** 내비게이션 접기·펼치기(Lucide `panel-left` 형태). */
export function PanelLeftIcon() {
  return (
    <svg {...BASE}>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M6 2.5v11" />
    </svg>
  );
}
