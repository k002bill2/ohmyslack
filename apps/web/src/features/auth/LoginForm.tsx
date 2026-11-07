import { useId, useState, type FormEvent } from 'react';
import { LOGIN_COPY } from '../../ui/copy.js';
import { ErrorState } from '../../ui/ErrorState.js';
import { AuthBrand } from './AuthBrand.js';

/** 로그인 결과. 네트워크 오류는 reject(throw)로 전달한다. */
export type LoginResult = { readonly ok: true } | { readonly ok: false; readonly status: number };

export interface LoginFormProps {
  readonly sessionEnded?: boolean;
  readonly onLogin: (email: string, password: string) => Promise<LoginResult>;
  readonly onSuccess: () => void;
}

export const SESSION_ENDED_TEXT = '세션이 종료되었습니다. 다시 로그인해 주세요.';
export const RATE_LIMITED_TEXT = '잠시 후 다시 시도해 주세요';

/** 실패 종류(G-01–G-04). 429는 기존 제한 문구, 그 외 4xx는 원인을 구분하지 않는 자격 증명 오류. */
type LoginError = 'limited' | 'credentials' | 'invalid' | 'server' | 'network';

function classify(status: number): LoginError {
  if (status === 429) return 'limited';
  if (status === 400) return 'invalid';
  if (status >= 500) return 'server';
  return 'credentials';
}

/** CMP-19 로그인 폼(UI_STATES §2-9, COPY_GAPS G-01–G-05). */
export function LoginForm({ sessionEnded = false, onLogin, onSuccess }: LoginFormProps) {
  const emailId = useId();
  const passwordId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<LoginError | null>(null);

  const attempt = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await onLogin(email, password);
      if (result.ok) {
        onSuccess();
        return;
      }
      setError(classify(result.status));
    } catch {
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
        <AuthBrand title={LOGIN_COPY.title} intro={LOGIN_COPY.intro} />
        {sessionEnded && <p role="status">{SESSION_ENDED_TEXT}</p>}
        <label htmlFor={emailId}>이메일</label>
        <input id={emailId} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor={passwordId}>비밀번호</label>
        <input
          id={passwordId}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error === 'limited' && <p role="alert">{RATE_LIMITED_TEXT}</p>}
        {error === 'credentials' && <p role="alert">{LOGIN_COPY.credentials}</p>}
        {error === 'invalid' && <p role="alert">{LOGIN_COPY.invalidRequest}</p>}
        {error === 'network' && <ErrorState message={LOGIN_COPY.network} onRetry={retry} retryDisabled={pending} />}
        {error === 'server' && <ErrorState message={LOGIN_COPY.server} onRetry={retry} retryDisabled={pending} />}
        <button type="submit" disabled={pending}>로그인</button>
      </form>
    </div>
  );
}
