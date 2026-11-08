import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ActionFailure, ActionResult, Member } from '../../data';
import { DM_STARTER_COPY } from '../../ui/copy.js';
import { ErrorState } from '../../ui/ErrorState.js';
import { failureText, isRetryable } from './failure.js';

export interface DmStarterProps {
  /** 콤보박스 접근 이름으로 쓸 제목 요소 ID(Dialog `titleId`). 멤버 선택 라벨 문구는 정본에 없다(REPORT Q). */
  readonly labelledBy: string;
  /** 본인 ID — 후보에서 뺀다. */
  readonly selfId: string | undefined;
  readonly load: () => Promise<ActionResult<readonly Member[]>>;
  readonly start: (userId: string) => Promise<ActionResult<string>>;
  /** DM 열기 성공(새 DM 또는 기존 DM) → 그 대화로 이동(FR-CONV-03). */
  readonly onStarted: (conversationId: string) => void;
}

type View =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly failure: ActionFailure }
  | { readonly kind: 'ready'; readonly members: readonly Member[] };

/** CMP-24 DmStarter(UI_STATES §2-11): 멤버 콤보박스(네이티브 select) → 「DM 시작」. 빈·오류 상태. */
export function DmStarter({ labelledBy, selfId, load, start, onStarted }: DmStarterProps) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ActionFailure | null>(null);

  const fetchMembers = useCallback(async () => {
    setView({ kind: 'loading' });
    const res = await load();
    if (!res.ok) {
      setView({ kind: 'error', failure: res });
      return;
    }
    // 봇은 후보에서 뺀다 — 서버가 사람→봇 DM을 거부한다(W-19b). 봇 DM은 서버가 만들어 목록에 이미 있다.
    const others = res.value.filter((m) => m.id !== selfId && m.kind !== 'bot');
    setPicked(others[0]?.id ?? '');
    setView({ kind: 'ready', members: others });
  }, [load, selfId]);

  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || picked === '') return;
    setBusy(true);
    setFailure(null);
    const res = await start(picked);
    setBusy(false);
    if (res.ok) onStarted(res.value);
    else setFailure(res);
  };

  if (view.kind === 'loading') return <div className="skeleton" aria-busy="true" />;
  if (view.kind === 'error') {
    return <ErrorState message={failureText(view.failure)} {...(isRetryable(view.failure) ? { onRetry: () => void fetchMembers() } : {})} />;
  }
  if (view.members.length === 0) return <p className="empty-state">{DM_STARTER_COPY.empty}</p>;
  return (
    <form className="dm-starter" onSubmit={(e) => void submit(e)}>
      <select aria-labelledby={labelledBy} value={picked} onChange={(e) => setPicked(e.target.value)}>
        {view.members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName}
          </option>
        ))}
      </select>
      {failure !== null && <ErrorState message={failureText(failure)} />}
      <button type="submit" disabled={busy}>
        {DM_STARTER_COPY.start}
      </button>
    </form>
  );
}
