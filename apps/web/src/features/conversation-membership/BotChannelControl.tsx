import { useEffect, useRef, useState } from 'react';
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
  /** 활성 봇. 0개면 아무것도 렌더하지 않는다. */
  readonly bots: readonly ChannelBot[];
  /** 지금 채널 멤버 ID(멘션 후보원과 같은 `GET …/members`). */
  readonly memberIds: ReadonlySet<string>;
  readonly onAdd: (botUserId: string) => Promise<ActionResult<null>>;
  readonly onRemove: (botUserId: string) => Promise<ActionResult<null>>;
}

/**
 * 채널 헤더 봇 컨트롤(FR-BOT-11, BOT_CHANNEL_SPEC §3-1 2번 위치). 봇마다: 채널에 없으면 「봇 추가」, 있으면 「봇 제거」 → 확인 Dialog.
 * 노출 판정(owner·채널·참여 중)은 호출자가 `canManageChannelBots`로 한다. 성공 뒤 목록 갱신도 호출자(onAdd·onRemove)가 한다.
 */
export function BotChannelControl({ bots, memberIds, onAdd, onRemove }: BotChannelControlProps) {
  if (bots.length === 0) return null;
  return (
    <div className="bot-channel-control">
      {bots.map((bot) =>
        memberIds.has(bot.id) ? (
          <RemoveBotButton key={bot.id} bot={bot} onRemove={onRemove} />
        ) : (
          <AddBotButton key={bot.id} bot={bot} onAdd={onAdd} />
        ),
      )}
    </div>
  );
}

function AddBotButton({ bot, onAdd }: { readonly bot: ChannelBot; readonly onAdd: BotChannelControlProps['onAdd'] }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const add = async () => {
    setBusy(true);
    setFailure(null);
    const res = await onAdd(bot.id);
    setBusy(false);
    if (!res.ok) setFailure(res);
  };
  return (
    <>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void add()}>
        {BOT_CHANNEL_COPY.add(bot.displayName)}
      </button>
      {failure !== null && <ErrorState message={`${BOT_CHANNEL_COPY.addFailed} ${failureText(failure)}`} />}
    </>
  );
}

/** 「채널 나가기」 확인 Dialog(`LeaveChannelControl`)와 같은 규칙: body 포털, 닫으면 진행 중 결과를 버린다. */
function RemoveBotButton({ bot, onRemove }: { readonly bot: ChannelBot; readonly onRemove: BotChannelControlProps['onRemove'] }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const attempt = useRef(0);
  const close = () => {
    attempt.current += 1;
    setOpen(false);
    setBusy(false);
    setFailure(null);
  };
  const confirm = async () => {
    const mine = ++attempt.current;
    setBusy(true);
    setFailure(null);
    const res = await onRemove(bot.id);
    if (mine !== attempt.current) return;
    setBusy(false);
    if (res.ok) setOpen(false);
    else setFailure(res);
  };
  const title = BOT_CHANNEL_COPY.title(bot.displayName);
  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
        {title}
      </button>
      {open &&
        createPortal(
          <Dialog title={title} onClose={close}>
            <div className="dialog-form">
              <p>{BOT_CHANNEL_COPY.body}</p>
              {failure !== null && <ErrorState message={failureText(failure)} />}
              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={close}>
                  {CANCEL_LABEL}
                </button>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void confirm()}>
                  {BOT_CHANNEL_COPY.confirm}
                </button>
              </div>
            </div>
          </Dialog>,
          document.body,
        )}
    </>
  );
}
