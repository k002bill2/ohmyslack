import { useId } from 'react';
import type { DataSource } from '../../data';
import { DIALOG_CLOSE_LABEL, DIALOG_TITLES } from '../../ui/copy.js';
import { Dialog } from '../../ui/Dialog.js';
import { ChannelBrowser, CreateChannelForm, DmStarter } from '../spaces';
import type { Breakpoint } from './viewport.js';

/** 사이드바 진입점이 여는 패널 종류. */
export type PanelKind = 'create' | 'browse' | 'dm';

const TITLES: Readonly<Record<PanelKind, string>> = {
  create: DIALOG_TITLES.createChannel,
  browse: DIALOG_TITLES.browseChannels,
  dm: DIALOG_TITLES.startDm,
};

interface SpacePanelProps {
  readonly kind: PanelKind;
  readonly breakpoint: Breakpoint;
  readonly dataSource: DataSource;
  readonly selfId: string | undefined;
  readonly onClose: () => void;
  readonly onDone: (conversationId: string) => void;
}

function PanelBody({ kind, dataSource, selfId, onDone, titleId }: SpacePanelProps & { readonly titleId: string }) {
  const ds = dataSource;
  if (kind === 'create' && ds.createChannel) {
    return <CreateChannelForm labelledBy={titleId} create={(n) => ds.createChannel!(n)} onCreated={onDone} />;
  }
  if (kind === 'browse' && ds.discoverChannels && ds.joinChannel) {
    return <ChannelBrowser load={ds.discoverChannels} join={ds.joinChannel} onJoined={onDone} />;
  }
  if (kind === 'dm' && ds.listMembers && ds.startDm) {
    return <DmStarter labelledBy={titleId} selfId={selfId} load={ds.listMembers} start={ds.startDm} onStarted={onDone} />;
  }
  return null;
}

/**
 * 공간 진입 패널: medium·wide는 CMP-18 Dialog, compact는 화면(UI_STATES §3-2 「채널 찾기 / DM 시작」 행).
 * 채널 만들기는 정본이 compact 화면을 정하지 않아 compact에서도 같은 화면 형식을 쓴다(REPORT 해석).
 */
export function SpacePanel(props: SpacePanelProps) {
  const screenTitleId = useId();
  if (props.breakpoint !== 'compact') {
    return <Dialog title={TITLES[props.kind]} onClose={props.onClose}>{({ titleId }) => <PanelBody {...props} titleId={titleId} />}</Dialog>;
  }
  return (
    <section className="space-screen" aria-labelledby={screenTitleId}>
      <header className="space-screen-header">
        <button type="button" onClick={props.onClose}>
          {DIALOG_CLOSE_LABEL}
        </button>
        <h1 id={screenTitleId}>{TITLES[props.kind]}</h1>
      </header>
      <PanelBody {...props} titleId={screenTitleId} />
    </section>
  );
}
