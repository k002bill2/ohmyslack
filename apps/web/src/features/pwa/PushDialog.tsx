import { DIALOG_TITLES, PUSH_SETTINGS_COPY } from '../../ui/copy.js';
import { Dialog } from '../../ui/Dialog.js';
import { PushSettings, type PushEnv, type PushServerApi } from './PushSettings.js';

/**
 * Jarvis DM 알림 설정 Dialog(G-74, 2026-11-16 영환님 지시). 헤더 더보기 「알림 설정…」로 연다.
 * 본문 위 1회 안내 배너(★Q-H4 제안)를 대체한다 — 대화 내용을 가리지 않는다.
 */
export function PushDialog({ env, server, onClose }: {
  readonly env: PushEnv;
  readonly server: PushServerApi;
  readonly onClose: () => void;
}) {
  return (
    <Dialog title={DIALOG_TITLES.notifications} onClose={onClose}>
      <p className="push-dialog-hint">{PUSH_SETTINGS_COPY.botHint}</p>
      <PushSettings env={env} server={server} />
    </Dialog>
  );
}
