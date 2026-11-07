import type { ConnectionState } from '../../data';

/** 디자인 §6-4 ConnectionBanner 문구 정본(§4-3 연결 상태 행). 연결됨은 숨김. */
export const CONNECTION_TEXT: Readonly<Record<Exclude<ConnectionState, 'connected'>, string>> = Object.freeze({
  reconnecting: '다시 연결 중…',
  offline: '연결이 끊겼습니다. 지금 보내는 메시지는 저장되지 않습니다. 연결되면 다시 시도하세요.',
  'catching-up': '최신 상태 확인 중…',
});

/** 배너 아이콘(장식, 시안 02·07): 끊김 = 사선 그은 신호, 그 밖 = 순환 화살표. 상태는 문구가 전한다(색·아이콘 외 텍스트). */
function BannerIcon({ state }: { readonly state: ConnectionState }) {
  const common = {
    className: 'connection-banner-icon',
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
  if (state === 'offline') {
    return (
      <svg {...common}>
        <path d="M2 6.5a9 9 0 0 1 12 0" />
        <path d="M4.5 9a5.5 5.5 0 0 1 7 0" />
        <path d="M8 12h.01" />
        <path d="M2.5 2.5l11 11" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M13 8a5 5 0 0 1-8.5 3.5" />
      <path d="M3 8a5 5 0 0 1 8.5-3.5" />
      <path d="M11.5 2v2.5H9" />
      <path d="M4.5 14v-2.5H7" />
    </svg>
  );
}

/** CMP-15 ConnectionBanner — `role="status"` `aria-live="polite"`, 상태를 색 외 텍스트로(FR-CLIENT-07, D3). */
export function ConnectionBanner({ state }: { readonly state: ConnectionState }) {
  const text = state === 'connected' ? '' : CONNECTION_TEXT[state];
  return (
    <div className="connection-banner" role="status" aria-live="polite" data-state={state} hidden={state === 'connected'}>
      {state !== 'connected' && <BannerIcon state={state} />}
      {text}
    </div>
  );
}
