import { useCallback, useEffect, useState } from 'react';
import type { ActionFailure, ActionResult, DiscoverChannel } from '../../data';
import { CHANNEL_BROWSER_COPY } from '../../ui/copy.js';
import { ErrorState } from '../../ui/ErrorState.js';
import { failureText, isRetryable } from './failure.js';

export interface ChannelBrowserProps {
  readonly load: () => Promise<ActionResult<readonly DiscoverChannel[]>>;
  readonly join: (conversationId: string) => Promise<ActionResult<string>>;
  /** 참여 성공(목록 갱신 완료) → 그 대화로 이동. */
  readonly onJoined: (conversationId: string) => void;
}

type View =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly failure: ActionFailure }
  | { readonly kind: 'list'; readonly channels: readonly DiscoverChannel[] };

/** CMP-23 ChannelBrowser(UI_STATES §2-11): 로딩·빈·기본·참여 중(해당 버튼 비활성)·오류. */
export function ChannelBrowser({ load, join, onJoined }: ChannelBrowserProps) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [joining, setJoining] = useState<string | null>(null);
  const [joinFailure, setJoinFailure] = useState<ActionFailure | null>(null);

  const fetchList = useCallback(async () => {
    setView({ kind: 'loading' });
    const res = await load();
    setView(res.ok ? { kind: 'list', channels: res.value } : { kind: 'error', failure: res });
  }, [load]);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  const onJoin = async (id: string) => {
    setJoining(id);
    setJoinFailure(null);
    const res = await join(id);
    setJoining(null);
    if (res.ok) onJoined(res.value);
    else setJoinFailure(res);
  };

  if (view.kind === 'loading') return <div className="skeleton" aria-busy="true" />;
  if (view.kind === 'error') {
    return <ErrorState message={failureText(view.failure)} {...(isRetryable(view.failure) ? { onRetry: () => void fetchList() } : {})} />;
  }
  if (view.channels.length === 0) return <p className="empty-state">{CHANNEL_BROWSER_COPY.empty}</p>;
  return (
    <>
      {joinFailure !== null && <ErrorState message={failureText(joinFailure)} />}
      <ul className="channel-browser">
        {view.channels.map((c) => (
          <li key={c.id}>
            <span id={`discover-${c.id}`}>{c.name}</span>
            <button type="button" aria-describedby={`discover-${c.id}`} disabled={joining === c.id} onClick={() => void onJoin(c.id)}>
              {CHANNEL_BROWSER_COPY.join}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
