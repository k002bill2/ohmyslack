import { useEffect, useId, useState, type FormEvent } from 'react';
import { RATE_LIMITED_TEXT } from './LoginForm.js';

export type InviteResult = { readonly ok: true } | { readonly ok: false; readonly status: number };

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
}

export const INVITE_UNUSABLE_TEXT = '이 초대 링크는 더 이상 사용할 수 없습니다';

/** `#t=<token>`에서 토큰만 꺼낸다. 없거나 비면 null. */
export function parseInviteHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const token = new URLSearchParams(raw).get('t');
  return token === null || token === '' ? null : token;
}

/** 429를 제외한 4xx는 만료·사용됨·폐기·무효를 구분하지 않고 사용 불가로 본다(D §6-2). */
function isUnusable(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

/**
 * CMP-19 초대 수락(D §4-2, UI_STATES §2-9). 토큰은 컴포넌트 메모리에만 두고 DOM·저장소·로그에 쓰지 않는다.
 */
export function InviteAccept({ readHash, clearHash, onAccept, onSuccess, displayNameLabel }: InviteAcceptProps) {
  // 마운트 시 1회만 읽는다. 해시는 effect에서 즉시 지운다.
  const [token] = useState<string | null>(() => parseInviteHash(readHash()));
  const emailId = useId();
  const passwordId = useId();
  const displayNameId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [pending, setPending] = useState(false);
  const [limited, setLimited] = useState(false);
  const [unusable, setUnusable] = useState(token === null);

  useEffect(() => {
    clearHash();
    // 마운트 1회 — clearHash 정체성 변화로 다시 부르지 않는다.
  }, []);

  if (unusable || token === null) return <p role="alert">{INVITE_UNUSABLE_TEXT}</p>;

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setLimited(false);
    const base = { token, email, password };
    const req: InviteAcceptRequest = displayNameLabel === undefined ? base : { ...base, display_name: displayName };
    try {
      const result = await onAccept(req);
      if (result.ok) {
        onSuccess();
        return;
      }
      if (result.status === 429) setLimited(true);
      else if (isUnusable(result.status)) setUnusable(true);
      // 5xx: 정본 문구 없음 — 폼 유지, 같은 토큰으로 재시도 가능.
    } catch {
      // 네트워크 오류(I-5): 정본 문구 없음 — 폼 유지, 메모리의 토큰으로 재시도.
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
      <label htmlFor={emailId}>이메일</label>
      <input id={emailId} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor={passwordId}>비밀번호</label>
      <input
        id={passwordId}
        type="password"
        autoComplete="new-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {displayNameLabel !== undefined && (
        <>
          <label htmlFor={displayNameId}>{displayNameLabel}</label>
          <input id={displayNameId} type="text" autoComplete="nickname" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </>
      )}
      {limited && <p role="alert">{RATE_LIMITED_TEXT}</p>}
      <button type="submit" disabled={pending}>수락</button>
    </form>
  );
}
