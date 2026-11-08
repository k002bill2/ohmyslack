import { DIALOG_TITLES, SHORTCUT_ROWS } from '../../ui/copy.js';
import { Dialog } from '../../ui/Dialog.js';

/** SCR-09 키보드 단축키 안내(CMP-18, D §7-3 `Ctrl/⌘+/`). 행은 정본 키맵 그대로(copy.ts `SHORTCUT_ROWS`). */
export function ShortcutsDialog({ onClose }: { readonly onClose: () => void }) {
  return (
    <Dialog title={DIALOG_TITLES.shortcuts} onClose={onClose}>
      <dl className="shortcut-list">
        {SHORTCUT_ROWS.map((row) => (
          <div key={row.keys} className="shortcut-row">
            <dt>
              <kbd>{row.keys}</kbd>
            </dt>
            <dd>{row.action}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
