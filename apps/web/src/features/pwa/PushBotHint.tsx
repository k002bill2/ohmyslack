import { useState } from 'react';
import { PUSH_SETTINGS_COPY } from '../../ui/copy.js';
import { PushSettings, type PushEnv, type PushServerApi } from './PushSettings.js';

/**
 * Jarvis DM 첫 진입 시 1회 알림 안내(★ UI_STATES §8 Q-H4 제안). 닫으면 이 탭에서는 다시 보이지 않는다.
 * 닫음 표시는 화면 메모리(모듈 변수)에만 둔다 — 브라우저 저장소에 쓰지 않는다(B7 예외 목록 밖).
 */
let dismissed = false;

/** 테스트용: 닫음 표시를 되돌린다. */
export function resetPushBotHint(): void {
  dismissed = false;
}

export function PushBotHint({ env, server }: { readonly env: PushEnv; readonly server: PushServerApi }) {
  const [hidden, setHidden] = useState(dismissed);
  if (hidden) return null;
  const dismiss = () => {
    dismissed = true;
    setHidden(true);
  };
  return (
    <aside className="push-bot-hint" aria-label={PUSH_SETTINGS_COPY.title}>
      <p>{PUSH_SETTINGS_COPY.botHint}</p>
      <PushSettings env={env} server={server} />
      <button type="button" className="btn btn-secondary" onClick={dismiss}>
        {PUSH_SETTINGS_COPY.dismissHint}
      </button>
    </aside>
  );
}
