/**
 * 코드 블록 복사 버튼 아이콘(장식용, `aria-hidden`). Lucide `copy`·`check`·`x`(ISC) 원본 도형을 좌표 그대로 인라인 SVG로 그린다
 * — 패키지·CDN 없음. 색은 `currentColor`, 접근 이름은 감싼 버튼의 `aria-label`이 가진다.
 * `data-icon`은 상태 확인용 안정 속성(테스트).
 */
const BASE = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const;

export type CodeCopyIconName = 'copy' | 'check' | 'x';

export function CodeCopyIcon({ name }: { readonly name: CodeCopyIconName }) {
  if (name === 'check') {
    return (
      <svg {...BASE} data-icon="check">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }
  if (name === 'x') {
    return (
      <svg {...BASE} data-icon="x">
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    );
  }
  return (
    <svg {...BASE} data-icon="copy">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}
