import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ActionFailure, ActionResult, Account, DataSource, Space } from '../../data';
import { BOT_CHANNEL_COPY, CANCEL_LABEL } from '../../ui/copy.js';
import { Dialog } from '../../ui/Dialog.js';
import { ErrorState } from '../../ui/ErrorState.js';
import { failureText } from '../spaces';

export interface ChannelBot {
  readonly id: string;
  readonly displayName: string;
}

/**
 * 봇 컨트롤을 보일 수 있는가(BOT_CHANNEL_SPEC §3-1·§3-5, FR-BOT-11): owner · 채널 · 참여 중.
 * 서버 403·400이 최종 진실이고, 이 판정은 진입점을 가리는 데만 쓴다.
 */
export function canManageChannelBots(account: Account | undefined, space: Space | undefined): boolean {
  return account?.role === 'owner' && space?.kind === 'channel' && space.left !== true;
}

/** 활성 봇 목록(`GET /api/members` kind='bot' — 활성 멤버만 온다). enabled일 때만 읽는다. 실패·미구현은 빈 목록. */
export function useActiveBots(dataSource: DataSource, enabled: boolean): readonly ChannelBot[] {
  const [bots, setBots] = useState<readonly ChannelBot[]>([]);
  useEffect(() => {
    if (!enabled || dataSource.listMembers === undefined) return undefined;
    let live = true;
    void dataSource.listMembers().then((res) => {
      if (!live) return;
      setBots(res.ok ? res.value.filter((m) => m.kind === 'bot').map((m) => ({ id: m.id, displayName: m.displayName })) : []);
    });
    return () => {
      live = false;
    };
  }, [dataSource, enabled]);
  return enabled ? bots : [];
}

export interface BotChannelControlProps {
  /** 활성 봇. 0개면 메뉴 항목이 없다. */
  readonly bots: readonly ChannelBot[];
  /** 지금 채널 멤버 ID(멘션 후보원과 같은 `GET …/members`). */
  readonly memberIds: ReadonlySet<string>;
  readonly onAdd: (botUserId: string) => Promise<ActionResult<null>>;
  readonly onRemove: (botUserId: string) => Promise<ActionResult<null>>;
}

/** 머리 더보기 메뉴 항목(HeaderMenu가 메뉴 항목으로 그린다). */
export interface BotMenuItem {
  readonly key: string;
  readonly label: string;
  readonly onSelect: () => void;
}

export interface BotChannelMenu {
  /** 봇마다 「봇 추가: 이름」 또는 「봇 제거: 이름」. 컨트롤이 없거나 봇 0개면 빈 목록. */
  readonly items: readonly BotMenuItem[];
  /** 추가 실패 표시(기존 ErrorState 문구) — 머리 아래에 둔다. */
  readonly failure: ReactNode;
  /** 제거 확인 Dialog(body 포털). */
  readonly dialog: ReactNode;
}

/**
 * 채널 봇 추가·제거(FR-BOT-11, BOT_CHANNEL_SPEC §3-1) — menu-bots-touch-focus: 머리 버튼 줄 대신 「대화 더보기」 메뉴 항목.
 * 추가는 바로 요청하고 실패는 `failure`로, 제거는 확인 Dialog(「채널 나가기」 `LeaveChannelControl`과 같은 규칙: body 포털,
 * 닫으면 진행 중 결과를 버린다). 메뉴가 닫히며 포커스를 「…」로 돌려준 뒤 Dialog가 열리므로 Dialog가 닫히면 「…」로 돌아간다.
 * 노출 판정(owner·채널·참여 중)과 성공 뒤 목록 갱신은 호출자(onAdd·onRemove)가 한다.
 */
export function useBotChannelMenu(control: BotChannelControlProps | undefined): BotChannelMenu {
  const [removing, setRemoving] = useState<ChannelBot | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeFailure, setRemoveFailure] = useState<ActionFailure | null>(null);
  const [addFailure, setAddFailure] = useState<ActionFailure | null>(null);
  const adding = useRef(new Set<string>());
  const attempt = useRef(0);

  const add = async (bot: ChannelBot) => {
    if (control === undefined || adding.current.has(bot.id)) return;
    adding.current.add(bot.id);
    setAddFailure(null);
    const res = await control.onAdd(bot.id);
    adding.current.delete(bot.id);
    if (!res.ok) setAddFailure(res);
  };
  const close = () => {
    attempt.current += 1;
    setRemoving(null);
    setBusy(false);
    setRemoveFailure(null);
  };
  const confirm = async (bot: ChannelBot) => {
    if (control === undefined) return;
    const mine = ++attempt.current;
    setBusy(true);
    setRemoveFailure(null);
    const res = await control.onRemove(bot.id);
    if (mine !== attempt.current) return;
    setBusy(false);
    if (res.ok) setRemoving(null);
    else setRemoveFailure(res);
  };

  const items: readonly BotMenuItem[] =
    control === undefined
      ? []
      : control.bots.map((bot) =>
          control.memberIds.has(bot.id)
            ? { key: `bot-remove-${bot.id}`, label: BOT_CHANNEL_COPY.title(bot.displayName), onSelect: () => setRemoving(bot) }
            : { key: `bot-add-${bot.id}`, label: BOT_CHANNEL_COPY.add(bot.displayName), onSelect: () => void add(bot) },
        );
  const failure = addFailure === null ? null : <ErrorState message={`${BOT_CHANNEL_COPY.addFailed} ${failureText(addFailure)}`} />;
  const title = removing === null ? '' : BOT_CHANNEL_COPY.title(removing.displayName);
  const dialog =
    removing === null
      ? null
      : createPortal(
          <Dialog title={title} onClose={close}>
            <div className="dialog-form">
              <p>{BOT_CHANNEL_COPY.body}</p>
              {removeFailure !== null && <ErrorState message={failureText(removeFailure)} />}
              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={close}>
                  {CANCEL_LABEL}
                </button>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void confirm(removing)}>
                  {BOT_CHANNEL_COPY.confirm}
                </button>
              </div>
            </div>
          </Dialog>,
          document.body,
        );
  return { items, failure, dialog };
}
