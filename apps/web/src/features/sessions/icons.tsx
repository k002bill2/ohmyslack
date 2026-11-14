/** 기기 행 아이콘(장식, `aria-hidden`). 외부 아이콘 패키지 없이 직접 그린 단순 도형 — 색은 `currentColor`. */
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

/** 휴대 기기(Lucide `smartphone` 형태). */
export function SmartphoneIcon() {
  return (
    <svg {...BASE}>
      <rect x="4" y="1.5" width="8" height="13" rx="1.5" />
      <path d="M7.5 12h1" />
    </svg>
  );
}

/** 노트북(Lucide `laptop` 형태). */
export function LaptopIcon() {
  return (
    <svg {...BASE}>
      <rect x="3" y="3" width="10" height="7" rx="1" />
      <path d="M1.5 13h13" />
    </svg>
  );
}
