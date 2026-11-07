import type { ConnectionState } from '../../data';

/** 디자인 §6-4 ConnectionBanner 문구 정본(§4-3 연결 상태 행). 연결됨은 숨김. */
export const CONNECTION_TEXT: Readonly<Record<Exclude<ConnectionState, 'connected'>, string>> = Object.freeze({
  reconnecting: '다시 연결 중…',
  offline: '연결이 끊겼습니다. 지금 보내는 메시지는 저장되지 않습니다. 연결되면 다시 시도하세요.',
  'catching-up': '최신 상태 확인 중…',
});

/** CMP-15 ConnectionBanner — `role="status"` `aria-live="polite"`, 상태를 색 외 텍스트로(FR-CLIENT-07, D3). */
export function ConnectionBanner({ state }: { readonly state: ConnectionState }) {
  const text = state === 'connected' ? '' : CONNECTION_TEXT[state];
  return (
    <div className="connection-banner" role="status" aria-live="polite" data-state={state} hidden={state === 'connected'}>
      {text}
    </div>
  );
}
