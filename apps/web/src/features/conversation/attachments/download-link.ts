import { ATTACHMENT_TEXT_MIMES } from '../../../../../../packages/shared/src/index.js';

/**
 * 문서 행 「받기」 링크 보조(UI_STATES §2-13 「받기」 행들). 판정은 이 모듈 한 곳에서만 한다.
 * 참고 출처: 일반 관념(iOS 홈 화면 앱의 `display-mode: standalone`·`navigator.standalone`), 저장소 내부 문서.
 */

/** 표시 방식 판정에 쓰는 환경(테스트 주입용). 없으면 일반 브라우저로 본다. */
export interface DisplayEnv {
  readonly matchMedia?: (query: string) => { readonly matches: boolean };
  readonly navigator?: { readonly standalone?: boolean };
}

function browserEnv(): DisplayEnv {
  if (typeof window === 'undefined') return {};
  return {
    ...(typeof window.matchMedia === 'function' ? { matchMedia: (q: string) => window.matchMedia(q) } : {}),
    navigator: window.navigator as { readonly standalone?: boolean },
  };
}

/** 홈 화면 앱(standalone)으로 실행 중인가. `matchMedia`가 없는 환경(jsdom 등)은 일반 브라우저. */
export function isStandaloneDisplay(env: DisplayEnv = browserEnv()): boolean {
  if (env.navigator?.standalone === true) return true;
  return env.matchMedia?.('(display-mode: standalone)').matches === true;
}

const VIEWER_MIMES: ReadonlySet<string> = new Set(['application/pdf', ...ATTACHMENT_TEXT_MIMES]);

/** iOS가 다운로드 시트 대신 창 안에서 직접 렌더하는 형식(PDF·텍스트 3종) — QA iPhone r2 B1. */
export function rendersInline(mime: string): boolean {
  return VIEWER_MIMES.has(mime);
}

/**
 * standalone + 직접 렌더 형식이면 새 창(iOS는 「완료」 버튼이 있는 시트로 연다)으로 받는다.
 * 그 밖에는 속성을 더하지 않는다(데스크톱·일반 브라우저 동작 불변).
 */
export function downloadLinkTarget(mime: string, standalone: boolean): { readonly target?: '_blank'; readonly rel?: 'noopener' } {
  return standalone && rendersInline(mime) ? { target: '_blank', rel: 'noopener' } : {};
}
