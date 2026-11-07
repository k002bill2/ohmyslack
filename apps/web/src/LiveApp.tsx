import { useCallback, useEffect, useRef, useState } from 'react';
import { createHttpDataSource, type HttpDataSource, type HttpDataSourceDeps } from './data/http-source.js';
import type { FetchLike } from './data/api.js';
import type { SocketLike } from './data/realtime.js';
import { LoginForm, type LoginResult } from './features/auth';
import { AppShell } from './features/layout';
import { createSessionBus, type SessionBus } from './features/sync';

type Phase =
  | { readonly kind: 'checking' }
  | { readonly kind: 'signed-out'; readonly sessionEnded: boolean }
  | { readonly kind: 'signed-in'; readonly source: HttpDataSource };

export interface LiveAppProps {
  readonly fetch: FetchLike;
  /** 데이터 소스 생성(테스트에서 가짜 WebSocket 주입). fetch·session은 LiveApp이 채운다. */
  readonly createSource: (deps: Pick<HttpDataSourceDeps, 'fetch' | 'session'>) => HttpDataSource;
  readonly session?: SessionBus;
}

/**
 * 운영 앱 루트(W-10c): 세션 확인 → 로그인(CMP-19) → HttpDataSource(REST + WS).
 * 세션 종료(401·로그아웃)면 DataSource를 버리고 로그인으로 돌아간다 — 401이면 「세션이 종료되었습니다」(S11).
 * 첫 진입의 세션 확인은 DataSource의 복귀 절차(`GET /api/me`)가 겸한다: 401이면 세션 종료 신호로 로그인 화면.
 */
export function LiveApp({ fetch, createSource, session: injected }: LiveAppProps) {
  const [session] = useState(() => injected ?? createSessionBus());
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
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
    const source = connect();
    return () => source.stop();
  }, [connect]);

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

  if (phase.kind === 'signed-in') return <AppShell dataSource={phase.source} />;
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
