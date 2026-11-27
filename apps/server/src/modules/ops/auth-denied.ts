/**
 * 접근 거부 → `auth_denied` 계측 매핑(PRD §10: action·reason enum, count). 원시 URL·토큰·ID는 쓰지 않고
 * 등록된 라우트 패턴과 오류 code만 본다. 매핑 밖 code(404 존재 은폐·검증 400 등)는 접근 거부로 세지 않는다.
 */
type DeniedAction = 'login' | 'session' | 'invite_accept' | 'api' | 'ws_upgrade';

const SESSION_ROUTES: ReadonlySet<string> = new Set(['/api/me', '/api/auth/logout', '/api/sessions', '/api/sessions/:id']);

function actionOf(route: string | undefined): DeniedAction {
  if (route === '/api/auth/login') return 'login';
  if (route === '/api/invites/accept') return 'invite_accept';
  if (route === '/api/ws') return 'ws_upgrade';
  if (route !== undefined && SESSION_ROUTES.has(route)) return 'session';
  return 'api';
}

/**
 * 오류 code → reason. `csrf_rejected`는 enum에 전용 사유가 없어 `forbidden`으로 묶는다(상태 변경 요청 거부라는 의미가 같다).
 * `unauthenticated`는 세션 쿠키가 없으면 no_session, 있었는데 거부되면 session_expired(만료·폐기·위조를 구분하지 않는다).
 */
function reasonOf(code: string, hadSessionCookie: boolean): string | undefined {
  switch (code) {
    case 'invalid_credentials':
      return 'bad_credentials';
    case 'rate_limited':
      return 'rate_limited';
    case 'unauthenticated':
      return hadSessionCookie ? 'session_expired' : 'no_session';
    case 'forbidden':
    case 'csrf_rejected':
      return 'forbidden';
    case 'origin_rejected':
    case 'host_not_allowed':
    case 'invite_invalid':
      return code;
    default:
      return undefined;
  }
}

/** 계측 입력(검증은 기록기가 한다). 접근 거부가 아니면 undefined. */
export function authDeniedMetric(code: string, route: string | undefined, hadSessionCookie: boolean): Readonly<Record<string, unknown>> | undefined {
  const reason = reasonOf(code, hadSessionCookie);
  if (reason === undefined) return undefined;
  return { event: 'auth_denied', action: actionOf(route), reason, count: 1 };
}
