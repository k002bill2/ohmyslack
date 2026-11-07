import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ActionFailure, ActionResult, Invite, Member } from '../../data';
import { FORBIDDEN_TEXT, MEMBER_ADMIN_COPY, MEMBER_DEACTIVATE_COPY } from '../../ui/copy.js';
import { ErrorState } from '../../ui/ErrorState.js';
import { failureText, isRetryable } from '../spaces';
import { DeactivateDialog } from './DeactivateDialog.js';
import { InviteDialog, type InviteView } from './InviteDialog.js';
import { inviteLink } from './format.js';

export interface MemberAdminProps {
  /** 내 계정 — owner가 아니면 요청 없이 「권한이 없습니다」(서버 403도 같은 화면). */
  readonly account: { readonly id: string; readonly role: 'owner' | 'member' } | undefined;
  readonly load: () => Promise<ActionResult<readonly Member[]>>;
  readonly createInvite: () => Promise<ActionResult<Invite>>;
  readonly deactivate: (userId: string) => Promise<ActionResult<null>>;
  /** 링크 앞부분(기본 `location.origin`). */
  readonly origin?: string;
}

type View =
  | { readonly kind: 'loading' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'error'; readonly failure: ActionFailure }
  | { readonly kind: 'ready'; readonly members: readonly Member[] };

interface Pending {
  readonly member: Member;
  readonly busy: boolean;
  readonly failure: ActionFailure | null;
}

/** 목록 행: 이름·역할·(이번 세션 비활성화면) 「비활성」. 본인 행·비활성 행은 버튼 없음. */
function MemberRow({ member, self, inactive, onDeactivate }: {
  readonly member: Member;
  readonly self: boolean;
  readonly inactive: boolean;
  readonly onDeactivate: () => void;
}) {
  return (
    <li className={inactive ? 'member-row member-inactive' : 'member-row'}>
      <span className="member-name">{member.displayName}</span>
      <span className="member-role">{MEMBER_ADMIN_COPY.roles[member.role]}</span>
      {inactive && <span className="member-status">{MEMBER_ADMIN_COPY.inactive}</span>}
      {!self && !inactive && (
        <button type="button" className="btn btn-secondary" aria-label={MEMBER_DEACTIVATE_COPY.rowButtonName(member.displayName)} onClick={onDeactivate}>
          {MEMBER_DEACTIVATE_COPY.rowButton}
        </button>
      )}
    </li>
  );
}

/**
 * CMP-25 MemberAdmin(`/settings/members`, UI_STATES §2-12): 로딩·기본·권한 없음·오류 + 초대 발급·비활성화 Dialog.
 * 목록 계약에 상태 필드가 없어 「비활성」은 이번 화면에서 비활성화한 행만 표시한다(서버는 비활성 멤버를 목록에서 뺀다).
 */
export function MemberAdmin({ account, load, createInvite, deactivate, origin = location.origin }: MemberAdminProps) {
  const owner = account?.role === 'owner';
  const titleId = useId();
  const [view, setView] = useState<View>(owner ? { kind: 'loading' } : { kind: 'forbidden' });
  const [invite, setInvite] = useState<InviteView | null>(null);
  const [inactive, setInactive] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  /** 발급 요청 차수 — 닫힌 뒤 도착한 응답은 버린다. */
  const issue = useRef(0);

  const fetchList = useCallback(async () => {
    setView({ kind: 'loading' });
    const res = await load();
    if (res.ok) setView({ kind: 'ready', members: res.value });
    else setView(res.status === 403 ? { kind: 'forbidden' } : { kind: 'error', failure: res });
  }, [load]);

  useEffect(() => {
    if (owner) void fetchList();
  }, [owner, fetchList]);

  const openInvite = async () => {
    issue.current += 1;
    const mine = issue.current;
    setInvite({ kind: 'loading' });
    const res = await createInvite();
    if (issue.current !== mine) return;
    setInvite(res.ok ? { kind: 'ready', link: inviteLink(origin, res.value.token), expiresAt: res.value.expiresAt } : { kind: 'error', failure: res });
  };
  /** 닫기 = 링크 폐기. 다시 열면 새로 발급한다. */
  const closeInvite = () => {
    issue.current += 1;
    setInvite(null);
  };

  const confirmDeactivate = async () => {
    if (pending === null || pending.busy) return;
    const target = pending.member;
    setPending({ member: target, busy: true, failure: null });
    const res = await deactivate(target.id);
    if (res.ok) {
      setInactive((prev) => new Set([...prev, target.id]));
      setPending(null);
    } else setPending({ member: target, busy: false, failure: res });
  };

  const body = (() => {
    if (view.kind === 'loading') return <div className="skeleton" aria-busy="true" />;
    if (view.kind === 'forbidden') return <p className="empty-state">{FORBIDDEN_TEXT}</p>;
    if (view.kind === 'error') {
      return <ErrorState message={failureText(view.failure)} {...(isRetryable(view.failure) ? { onRetry: () => void fetchList() } : {})} />;
    }
    return (
      <>
        <div className="member-admin-actions">
          <button type="button" className="btn btn-primary" onClick={() => void openInvite()}>
            {MEMBER_ADMIN_COPY.createInvite}
          </button>
        </div>
        <ul className="member-list" aria-labelledby={titleId}>
          {view.members.map((m) => (
            <MemberRow
              key={m.id}
              member={m}
              self={m.id === account?.id}
              inactive={inactive.has(m.id)}
              onDeactivate={() => setPending({ member: m, busy: false, failure: null })}
            />
          ))}
        </ul>
      </>
    );
  })();

  return (
    <main className="member-admin" aria-labelledby={titleId}>
      <h1 id={titleId} className="member-admin-title">
        {MEMBER_ADMIN_COPY.title}
      </h1>
      {body}
      {invite !== null && <InviteDialog view={invite} onRetry={() => void openInvite()} onClose={closeInvite} />}
      {pending !== null && (
        <DeactivateDialog
          busy={pending.busy}
          failure={pending.failure}
          onConfirm={() => void confirmDeactivate()}
          onCancel={() => setPending(null)}
        />
      )}
    </main>
  );
}
