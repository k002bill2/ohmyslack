import { useId, useState, type FormEvent } from 'react';

/** 로그인 결과. 네트워크 오류는 reject(throw)로 전달한다. */
export type LoginResult = { readonly ok: true } | { readonly ok: false; readonly status: number };

export interface LoginFormProps {
  readonly sessionEnded?: boolean;
  readonly onLogin: (email: string, password: string) => Promise<LoginResult>;
  readonly onSuccess: () => void;
}

export const SESSION_ENDED_TEXT = '세션이 종료되었습니다. 다시 로그인해 주세요.';
export const RATE_LIMITED_TEXT = '잠시 후 다시 시도해 주세요';

/**
 * CMP-19 로그인 폼(UI_STATES §2-9). 자격 증명 오류·네트워크 오류는 정본 문구가 없어(Q-1) 텍스트 없이 폼만 유지한다.
 */
export function LoginForm({ sessionEnded = false, onLogin, onSuccess }: LoginFormProps) {
  const emailId = useId();
  const passwordId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [limited, setLimited] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setLimited(false);
    try {
      const result = await onLogin(email, password);
      if (result.ok) {
        onSuccess();
        return;
      }
      setLimited(result.status === 429);
    } catch {
      // 네트워크 오류: 정본 문구 없음 — 폼 유지, 재시도 가능.
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
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
      {limited && <p role="alert">{RATE_LIMITED_TEXT}</p>}
      <button type="submit" disabled={pending}>로그인</button>
    </form>
  );
}
