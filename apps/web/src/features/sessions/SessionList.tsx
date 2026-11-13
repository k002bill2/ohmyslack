import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { settleAction, type ActionFailure, type ActionResult, type DeviceSession } from '../../data';
import { SESSION_LIST_COPY } from '../../ui/copy.js';
import { ErrorState } from '../../ui/ErrorState.js';
import { failureText, isRetryable } from '../spaces';
import { deviceIconKind, deviceLabel, lastUsedWhen, logoutName, sortSessions } from './format.js';
import { LaptopIcon, SmartphoneIcon } from './icons.js';
import { SessionLogoutDialog } from './SessionLogoutDialog.js';

export interface SessionListProps {
  readonly load: () => Promise<ActionResult<readonly DeviceSession[]>>;
  readonly revoke: (sessionId: string) => Promise<ActionResult<null>>;
  /** 「이 기기에서 로그아웃」 — 확인 없이 사이드바 로그아웃과 같은 절차(UI-D12). */
  readonly logoutThisDevice: () => void;
  /** 기준 시각(테스트 주입용, 기본 현재). */
  readonly now?: () => Date;
}

type View =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly failure: ActionFailure }
  | { readonly kind: 'ready'; readonly sessions: readonly DeviceSession[] };

interface Pending {
  readonly session: DeviceSession;
  readonly busy: boolean;
  readonly failure: ActionFailure | null;
}

/** 성공 후 포커스 대상(I-4 선례): 다음 다른 기기 행 → 이전 다른 기기 행 → 없으면 null(제목). */
function nextFocusId(sessions: readonly DeviceSession[], removedId: string): string | null {
  const others = sessions.filter((s) => !s.current);
  const at = others.findIndex((s) => s.id === removedId);
  return (others[at + 1] ?? others[at - 1])?.id ?? null;
}

function SessionRow({ session, all, now, onLogout, onLogoutThisDevice }: {
  readonly session: DeviceSession;
  readonly all: readonly DeviceSession[];
  readonly now: Date;
  readonly onLogout: () => void;
  readonly onLogoutThisDevice: () => void;
}) {
  const label = deviceLabel(session);
  return (
    <li className="member-row" data-session-id={session.id}>
      <span className="session-icon">{deviceIconKind(session) === 'laptop' ? <LaptopIcon /> : <SmartphoneIcon />}</span>
      <span className="session-text">
        <span className="session-label">{label}</span>
        {session.current && <span className="session-this-device">{SESSION_LIST_COPY.thisDevice}</span>}
        <span className="session-last-used">{SESSION_LIST_COPY.lastUsed(lastUsedWhen(session.lastSeenAt, now))}</span>
      </span>
      {session.current ? (
        <button type="button" className="btn btn-secondary" onClick={onLogoutThisDevice}>
          {SESSION_LIST_COPY.logoutThisDevice}
        </button>
      ) : (
        <button type="button" className="btn btn-secondary" data-session-logout={session.id} aria-label={logoutName(session, all, now)} onClick={onLogout}>
          {SESSION_LIST_COPY.logout}
        </button>
      )}
    </li>
  );
}

/**
 * CMP-22 SessionList(`/settings/sessions`, UI_STATES §2-14): 로딩·기본·빈(다른 기기 없음)·오류·시간 초과 + 기기 로그아웃 확인 Dialog.
 * 성공하면 행을 바로 빼고 목록을 조용히 다시 읽는다(로딩으로 바꾸지 않아 옮긴 포커스가 유지된다).
 */
export function SessionList({ load, revoke, logoutThisDevice, now = () => new Date() }: SessionListProps) {
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [pending, setPending] = useState<Pending | null>(null);
  const [status, setStatus] = useState('');
  /** 성공 후 옮길 포커스(행 id 또는 'title'). Dialog 언마운트의 트리거 복귀보다 뒤에 적용한다. */
  const [focusTarget, setFocusTarget] = useState<{ readonly id: string | null } | null>(null);
  /** 확인창 차수 — 닫힌 확인창의 늦은 응답이 새 확인창을 바꾸지 않게(MemberAdmin과 같음). */
  const confirmRound = useRef(0);
  const at = now();

  const fetchList = useCallback(
    async (quiet = false) => {
      if (!quiet) setView({ kind: 'loading' });
      const res = await load();
      if (res.ok) setView({ kind: 'ready', sessions: sortSessions(res.value) });
      else if (!quiet) setView({ kind: 'error', failure: res });
    },
    [load],
  );

  useEffect(() => {
    title.current?.focus();
    void fetchList();
  }, [fetchList]);

  // passive effect: Dialog 언마운트 정리(트리거 복귀·inert 해제) 뒤에 돈다.
  useEffect(() => {
    if (focusTarget === null) return;
    setFocusTarget(null);
    const id = focusTarget.id;
    const button = id === null ? null : list.current?.querySelector<HTMLElement>(`[data-session-logout="${CSS.escape(id)}"]`);
    (button ?? title.current)?.focus();
  }, [focusTarget]);

  const confirm = async () => {
    if (pending === null || pending.busy) return;
    const target = pending.session;
    const mine = confirmRound.current;
    setPending({ session: target, busy: true, failure: null });
    const res = await settleAction(() => revoke(target.id));
    if (res.ok) {
      const before = view.kind === 'ready' ? view.sessions : [];
      setView({ kind: 'ready', sessions: before.filter((s) => s.id !== target.id) });
      setStatus(SESSION_LIST_COPY.done(deviceLabel(target)));
      if (confirmRound.current === mine) {
        setPending(null);
        setFocusTarget({ id: nextFocusId(before, target.id) });
      }
      void fetchList(true);
      return;
    }
    if (confirmRound.current !== mine) return;
    setPending({ session: target, busy: false, failure: res });
  };
  const openConfirm = (session: DeviceSession) => {
    confirmRound.current += 1;
    setPending({ session, busy: false, failure: null });
  };
  const closeConfirm = () => {
    confirmRound.current += 1;
    setPending(null);
  };
  const refreshAfterNotFound = () => {
    closeConfirm();
    void fetchList();
  };

  const body = (() => {
    if (view.kind === 'loading') {
      return (
        <ul className="member-list session-list" aria-label={SESSION_LIST_COPY.title} aria-busy="true">
          <li className="skeleton" />
        </ul>
      );
    }
    if (view.kind === 'error') {
      return <ErrorState message={failureText(view.failure)} {...(isRetryable(view.failure) ? { onRetry: () => void fetchList() } : {})} />;
    }
    const others = view.sessions.filter((s) => !s.current);
    return (
      <>
        <ul ref={list} className="member-list session-list" aria-label={SESSION_LIST_COPY.title}>
          {view.sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              all={view.sessions}
              now={at}
              onLogout={() => openConfirm(s)}
              onLogoutThisDevice={logoutThisDevice}
            />
          ))}
        </ul>
        {others.length === 0 && <p className="empty-state">{SESSION_LIST_COPY.noOtherDevices}</p>}
      </>
    );
  })();

  return (
    <main className="member-admin session-admin" aria-labelledby={titleId}>
      <h1 id={titleId} ref={title} tabIndex={-1} className="member-admin-title">
        {SESSION_LIST_COPY.title}
      </h1>
      {body}
      <div className="visually-hidden" aria-live="polite">
        {status}
      </div>
      {pending !== null &&
        createPortal(
          <SessionLogoutDialog
            label={deviceLabel(pending.session)}
            busy={pending.busy}
            failure={pending.failure}
            onConfirm={() => void confirm()}
            onCancel={closeConfirm}
            onRefresh={refreshAfterNotFound}
          />,
          document.body,
        )}
    </main>
  );
}
