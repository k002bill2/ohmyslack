import { useEffect, useId, useState, type FormEvent } from 'react';
import { INVITE_COPY, LOGIN_PATH } from '../../ui/copy.js';
import { ErrorState } from '../../ui/ErrorState.js';
import { RATE_LIMITED_TEXT } from './LoginForm.js';

/** `code`: 서버 오류 본문의 `error.code`(있으면). 400 중 `invite_invalid`만 초대 무효다(Codex r3). */
export type InviteResult = { readonly ok: true } | { readonly ok: false; readonly status: number; readonly code?: string };

export interface InviteAcceptRequest {
  readonly token: string;
  readonly email: string;
  readonly password: string;
  readonly display_name?: string;
}

export interface InviteAcceptProps {
  /** 예: `() => location.hash` */
  readonly readHash: () => string;
  /** 예: `() => history.replaceState(null, '', location.pathname + location.search)` */
  readonly clearHash: () => void;
  readonly onAccept: (req: InviteAcceptRequest) => Promise<InviteResult>;
  readonly onSuccess: () => void;
  /** 정본 라벨이 없어 부모가 주입한다. 없으면 표시 이름 입력을 렌더하지 않고 display_name도 보내지 않는다. */
  readonly displayNameLabel?: string;
  /** G-13 「로그인」 링크 클릭(있으면 기본 이동 대신 호출 — 앱 안에서 로그인 화면으로 전환). */
  readonly onGoLogin?: () => void;
}

/** 폼을 유지하는 실패(G-09–G-12, 429). */
type InviteError = 'limited' | 'password' | 'invalid' | 'network' | 'server';

export const INVITE_UNUSABLE_TEXT = '이 초대 링크는 더 이상 사용할 수 없습니다';

/** `#t=<token>`에서 토큰만 꺼낸다. 없거나 비면 null. */
export function parseInviteHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const token = new URLSearchParams(raw).get('t');
  return token === null || token === '' ? null : token;
}

/** 429를 제외한 4xx는 만료·사용됨·폐기·무효를 구분하지 않고 사용 불가로 본다(D §6-2). */
function isUnusable(status: number, code: string | undefined): boolean {
  // 입력 오류(password_policy·invalid_request 등 400)는 폼을 유지해 고칠 수 있게 한다(Codex r3 P2).
  if (status === 400 && code !== undefined && code !== 'invite_invalid') return false;
  return status >= 400 && status < 500 && status !== 429;
}

function classify(status: number, code: string | undefined): InviteError | 'unusable' {
  if (status === 429) return 'limited';
  if (status === 400 && code === 'password_policy') return 'password';
  if (status === 400 && code !== undefined && code !== 'invite_invalid') return 'invalid';
  if (status >= 500) return 'server';
  return isUnusable(status, code) ? 'unusable' : 'server';
}

/** G-13: 정본 문구 + 보조 안내 + 「로그인」 링크. */
function Unusable({ onGoLogin }: { readonly onGoLogin?: (() => void) | undefined }) {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <p role="alert">{INVITE_UNUSABLE_TEXT}</p>
        <p>{INVITE_COPY.unusableHint}</p>
        <a
          href={LOGIN_PATH}
          onClick={(e) => {
            if (onGoLogin === undefined) return;
            e.preventDefault();
            onGoLogin();
          }}
        >
          {INVITE_COPY.loginLink}
        </a>
      </div>
    </div>
  );
}

/**
 * CMP-19 초대 수락(D §4-2, UI_STATES §2-9). 토큰은 컴포넌트 메모리에만 두고 DOM·저장소·로그에 쓰지 않는다.
 */
export function InviteAccept({ readHash, clearHash, onAccept, onSuccess, displayNameLabel, onGoLogin }: InviteAcceptProps) {
  // 마운트 시 1회만 읽는다. 해시는 effect에서 즉시 지운다.
  const [token] = useState<string | null>(() => parseInviteHash(readHash()));
  const emailId = useId();
  const passwordId = useId();
  const displayNameId = useId();
  const passwordHintId = useId();
  const displayNameHintId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<InviteError | null>(null);
  const [unusable, setUnusable] = useState(token === null);

  useEffect(() => {
    clearHash();
    // 마운트 1회 — clearHash 정체성 변화로 다시 부르지 않는다.
  }, []);

  if (unusable || token === null) return <Unusable onGoLogin={onGoLogin} />;

  const attempt = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(null);
    const base = { token, email, password };
    const req: InviteAcceptRequest = displayNameLabel === undefined ? base : { ...base, display_name: displayName };
    try {
      const result = await onAccept(req);
      if (result.ok) {
        onSuccess();
        return;
      }
      const kind = classify(result.status, result.code);
      if (kind === 'unusable') setUnusable(true);
      else setError(kind);
    } catch {
      // 네트워크 오류(I-5): 폼 유지, 메모리의 토큰으로 재시도(G-11).
      setError('network');
    } finally {
      setPending(false);
    }
  };

  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    void attempt();
  };
  const retry = () => void attempt();

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <h1>{INVITE_COPY.title}</h1>
        <p>{INVITE_COPY.intro}</p>
        <label htmlFor={emailId}>이메일</label>
        <input id={emailId} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor={passwordId}>비밀번호</label>
        <input
          id={passwordId}
          type="password"
          autoComplete="new-password"
          required
          aria-describedby={passwordHintId}
          aria-invalid={error === 'password' ? true : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p id={passwordHintId}>{INVITE_COPY.passwordHint}</p>
        {displayNameLabel !== undefined && (
          <>
            <label htmlFor={displayNameId}>{displayNameLabel}</label>
            <input
              id={displayNameId}
              type="text"
              autoComplete="nickname"
              aria-describedby={displayNameHintId}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <p id={displayNameHintId}>{INVITE_COPY.displayNameHint}</p>
          </>
        )}
        {error === 'limited' && <p role="alert">{RATE_LIMITED_TEXT}</p>}
        {error === 'password' && <p role="alert">{INVITE_COPY.passwordPolicy}</p>}
        {error === 'invalid' && <p role="alert">{INVITE_COPY.invalidRequest}</p>}
        {error === 'network' && <ErrorState message={INVITE_COPY.network} onRetry={retry} retryDisabled={pending} />}
        {error === 'server' && <ErrorState message={INVITE_COPY.server} onRetry={retry} retryDisabled={pending} />}
        <button type="submit" disabled={pending}>수락</button>
      </form>
    </div>
  );
}
