import { useCallback, useEffect, useRef, useState } from 'react';
import { createHttpDataSource, type HttpDataSource, type HttpDataSourceDeps } from './data/http-source.js';
import type { FetchLike } from './data/api.js';
import type { SocketLike } from './data/realtime.js';
import { InviteAccept, LoginForm, parseInviteHash, type InviteAcceptRequest, type InviteResult, type LoginResult } from './features/auth';
import { AppShell } from './features/layout';
import { createSessionBus, type SessionBus } from './features/sync';

type Phase =
  | { readonly kind: 'invite' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'signed-out'; readonly sessionEnded: boolean }
  | { readonly kind: 'signed-in'; readonly source: HttpDataSource };

export interface LiveAppProps {
  readonly fetch: FetchLike;
  /** 데이터 소스 생성(테스트에서 가짜 WebSocket 주입). fetch·session은 LiveApp이 채운다. */
  readonly createSource: (deps: Pick<HttpDataSourceDeps, 'fetch' | 'session'>) => HttpDataSource;
  readonly session?: SessionBus;
  /** 초대 링크 해시 읽기·제거(기본: `location.hash`, `history.replaceState`). 테스트 주입용. */
  readonly readHash?: () => string;
  readonly clearHash?: () => void;
}

/**
 * 표시 이름 입력 라벨 — 정본 문구 없음(auth/index.ts 참조). 서버 계약(`inviteAcceptRequestSchema`)이
 * `display_name`을 필수로 요구하므로 운영 루트는 입력을 렌더해야 한다(Codex r2 P1 배선, REPORT에 기록).
 */
const DISPLAY_NAME_LABEL = '표시 이름';

const browserReadHash = () => location.hash;
const browserClearHash = () => history.replaceState(null, '', location.pathname + location.search);

/**
 * 운영 앱 루트(W-10c): 세션 확인 → 로그인(CMP-19) → HttpDataSource(REST + WS).
 * 세션 종료(401·로그아웃)면 DataSource를 버리고 로그인으로 돌아간다 — 401이면 「세션이 종료되었습니다」(S11).
 * 첫 진입의 세션 확인은 DataSource의 복귀 절차(`GET /api/me`)가 겸한다: 401이면 세션 종료 신호로 로그인 화면.
 */
export function LiveApp({ fetch, createSource, session: injected, readHash = browserReadHash, clearHash = browserClearHash }: LiveAppProps) {
  const [session] = useState(() => injected ?? createSessionBus());
  // 초대 링크(`#t=<token>`)면 세션 확인 없이 수락 폼부터 — 토큰 자체는 InviteAccept 메모리에만 둔다(D §4-2).
  const [invited] = useState(() => parseInviteHash(readHash()) !== null);
  const [phase, setPhase] = useState<Phase>(() => (invited ? { kind: 'invite' } : { kind: 'checking' }));
  /** 한 번이라도 연결됐던 세션인가 — 첫 진입의 401(세션 없음)에는 「세션이 종료되었습니다」를 띄우지 않는다. */
  const hadSession = useRef(false);

  const connect = useCallback(() => {
    const source = createSource({ fetch, session });
    setPhase({ kind: 'signed-in', source });
    void source.start().then((ok) => {
      if (ok) hadSession.current = true;
    });
    return source;
  }, [createSource, fetch, session]);

  useEffect(
    () =>
      session.onEnd((reason) => {
        setPhase({ kind: 'signed-out', sessionEnded: reason === 'unauthorized' && hadSession.current });
        hadSession.current = false;
      }),
    [session],
  );

  // 첫 연결 소스는 만든 effect가 직접 정리한다 — StrictMode 이중 실행에서 버려진 소스의 WS·리스너가 남지 않는다(Codex r1 P2).
  useEffect(() => {
    if (invited) return undefined;
    const source = connect();
    return () => source.stop();
  }, [connect, invited]);

  useEffect(() => {
    if (phase.kind !== 'signed-in') return undefined;
    return () => phase.source.stop();
  }, [phase]);

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      return res.ok ? { ok: true } : { ok: false, status: res.status };
    },
    [fetch],
  );

  // 서버는 수락 성공 시 세션 쿠키를 심는다(201) — 이어서 connect()가 복귀 절차를 시작한다.
  const accept = useCallback(
    async (req: InviteAcceptRequest): Promise<InviteResult> => {
      const res = await fetch('/api/invites/accept', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
      return res.ok ? { ok: true } : { ok: false, status: res.status };
    },
    [fetch],
  );

  if (phase.kind === 'signed-in') return <AppShell dataSource={phase.source} />;
  if (phase.kind === 'invite') {
    return (
      <InviteAccept readHash={readHash} clearHash={clearHash} onAccept={accept} onSuccess={connect} displayNameLabel={DISPLAY_NAME_LABEL} />
    );
  }
  if (phase.kind === 'checking') return null;
  return <LoginForm sessionEnded={phase.sessionEnded} onLogin={login} onSuccess={connect} />;
}

/** 브라우저 기본 배선: same-origin `/api/ws`, 문서 가시성·온라인 이벤트. */
export function browserSource(deps: Pick<HttpDataSourceDeps, 'fetch' | 'session'>): HttpDataSource {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return createHttpDataSource({
    ...deps,
    wsUrl: `${scheme}//${location.host}/api/ws`,
    // 핸들러는 쓰기 전용(클라이언트가 대입만 한다) — DOM 이벤트 타입과의 매개변수 변성 차이만 맞춘다.
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    lifecycle: { doc: document, win: window },
  });
}
