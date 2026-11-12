import { DIALOG_TITLES, ERROR_COPY } from '../../ui/copy.js';
import type { Breakpoint } from './viewport.js';

/**
 * 주소의 대화가 확정된 목록에 없을 때(나간 채널 새로고침·삭제·권한 없음·오타 — QA §4-2) 빈 화면 대신 그리는 메인 영역.
 * 카피는 기존 `ERROR_COPY.notFound`, 행동은 기존 「채널 찾기」(API가 있을 때만). 자동 포커스는 하지 않는다(F4는 대화가 있을 때만).
 */
export function MissingConversation(props: {
  readonly breakpoint: Breakpoint;
  readonly onBack: () => void;
  readonly onBrowseChannels?: () => void;
}) {
  return (
    <main className="conversation-pane">
      {props.breakpoint === 'compact' && (
        <header className="conversation-header">
          <button type="button" className="icon-button conversation-back" aria-label="뒤로" title="뒤로" onClick={props.onBack}>
            <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false">
              <path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </header>
      )}
      <div className="left-channel-notice">
        <p>{ERROR_COPY.notFound}</p>
        {props.onBrowseChannels !== undefined && (
          <button type="button" className="btn btn-primary" onClick={props.onBrowseChannels}>
            {DIALOG_TITLES.browseChannels}
          </button>
        )}
      </div>
    </main>
  );
}
