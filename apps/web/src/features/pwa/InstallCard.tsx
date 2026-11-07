import { InstallHint, type InstallMode } from './install.js';

/**
 * 시안 04: compact 공간 목록 위 설치 안내 카드(CMP-20 InstallHint를 카드로 감싼다).
 * 프롬프트 수신·보관(`useInstallPrompt`)은 계속 마운트된 소유자(셸)가 한다 — 카드만 조건부로 마운트(Codex r1 P2).
 * standalone·미지원이면 아무것도 렌더하지 않는다(UI_STATES §2-10). 정본에 닫기·기억 규칙이 없어 닫기 버튼은 두지 않는다.
 */
export function InstallCard({ mode, onInstall }: { readonly mode: InstallMode; readonly onInstall: () => void }) {
  if (mode !== 'prompt' && mode !== 'ios') return null;
  return (
    <aside className="install-card">
      <InstallHint mode={mode} onInstall={onInstall} />
    </aside>
  );
}
