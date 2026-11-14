/**
 * 「받기」 만료 사전 확인(UI_STATES §2-13 「받기 · 만료 사전 확인」 행, QA iPhone r2 B7).
 * 참고 출처: 일반 관념(HTTP HEAD), 저장소 내부 문서.
 */

/** 만료 사전 확인 상한(UI_STATES §2-13 「받기 · 만료 사전 확인」 행). */
export const EXPIRY_CHECK_TIMEOUT_MS = 3000;

/** 만료·삭제 첨부의 다운로드 응답 상태(서버 `service.read`가 `isExpired`면 404 — 존재 은폐와 같은 코드). */
const EXPIRED_STATUS = 404;

type HeadFetch = (url: string, init: RequestInit) => Promise<{ readonly status: number }>;

/**
 * 「받기」 직전 `HEAD`로 만료만 확인한다(본문을 받지 않는다 — B7). 만료 응답이면 true.
 * 200·그 밖의 상태·네트워크 오류·시간 초과는 false(기존 링크 동작으로 진행, UI-D5).
 */
export async function isAttachmentGone(url: string, fetchFn: HeadFetch = (u, i) => fetch(u, i), timeoutMs = EXPIRY_CHECK_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { method: 'HEAD', credentials: 'include', cache: 'no-store', signal: controller.signal });
    return res.status === EXPIRED_STATUS;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
