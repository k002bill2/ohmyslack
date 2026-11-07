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
