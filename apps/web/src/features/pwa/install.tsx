import { useCallback, useEffect, useState } from 'react';
import { INSTALL_COPY } from '../../ui/copy.js';

export type InstallMode = 'standalone' | 'prompt' | 'ios' | 'unsupported';

interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
}

/** CMP-20 분기: standalone이면 숨김, beforeinstallprompt 지원 시 버튼, iOS Safari는 안내 문구. */
export function detectInstallMode(env: { readonly standalone: boolean; readonly canPrompt: boolean; readonly userAgent: string }): InstallMode {
  if (env.standalone) return 'standalone';
  if (env.canPrompt) return 'prompt';
  return /iPhone|iPad|iPod/.test(env.userAgent) ? 'ios' : 'unsupported';
}

function isStandalone(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
}

/** `beforeinstallprompt`를 붙잡아 두었다가 install()에서 브라우저 설치 프롬프트를 연다. */
export function useInstallPrompt(): { readonly mode: InstallMode; readonly install: () => Promise<void> } {
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null);
  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);
  const install = useCallback(async () => {
    if (deferred === null) return;
    setDeferred(null);
    await deferred.prompt();
  }, [deferred]);
  const mode = detectInstallMode({ standalone: isStandalone(), canPrompt: deferred !== null, userAgent: navigator.userAgent });
  return { mode, install };
}

export interface InstallCopy {
  readonly button?: string;
  readonly ios?: string;
}

/**
 * CMP-20 InstallHint(G-14·G-15). 기본 문구는 `INSTALL_COPY`. 문구 항목이 없으면 그 분기는 렌더하지 않는다.
 * macOS 분기 문장(G-16)은 보류라 두지 않는다 — 'unsupported'는 렌더 없음.
 */
export function InstallHint({ mode, onInstall, copy = INSTALL_COPY }: { readonly mode: InstallMode; readonly onInstall: () => void; readonly copy?: InstallCopy }) {
  if (mode === 'prompt' && copy.button !== undefined) {
    return (
      <button type="button" className="install-hint" onClick={onInstall}>
        {copy.button}
      </button>
    );
  }
  if (mode === 'ios' && copy.ios !== undefined) return <p className="install-hint">{copy.ios}</p>;
  return null;
}
