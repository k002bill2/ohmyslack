/** QA §4-2: 주소의 대화가 확정된 목록에 없으면(나간 채널 새로고침·삭제·권한 없음·오타) 빈 화면 대신 안내 + 「채널 찾기」. */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '../../src/app/route.js';
import { createMemoryDataSource, type DataSource, type Snapshot } from '../../src/data';
import { AppShell } from '../../src/features/layout';
import { DIALOG_TITLES, ERROR_COPY } from '../../src/ui/copy.js';
import { installViewport } from '../helpers/viewport.js';

const C1 = '11111111-1111-4111-8111-111111111111';
const MISSING = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

afterEach(cleanup);

function seed(extra: Partial<Snapshot> = {}): Snapshot {
  return {
    spaces: [{ id: C1, kind: 'channel', name: 'general', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 }],
    messages: [],
    connection: 'connected',
    ...extra,
  };
}

function withBrowse(snapshot: Snapshot): DataSource {
  return {
    ...createMemoryDataSource(snapshot),
    discoverChannels: vi.fn(() => Promise.resolve({ ok: true as const, value: [] })),
    joinChannel: vi.fn(() => Promise.resolve({ ok: true as const, value: C1 })),
  };
}

function open(width: number, path: string, dataSource: DataSource) {
  installViewport(width);
  return render(<AppShell dataSource={dataSource} history={createMemoryHistory(path)} />);
}

describe('주소의 대화가 목록에 없음', () => {
  it('wide: 목록 확정 후 없으면 안내와 「채널 찾기」, 누르면 채널 찾기 Dialog', async () => {
    const user = userEvent.setup();
    open(1280, `/c/${MISSING}`, withBrowse(seed()));
    const main = screen.getByRole('main');
    expect(within(main).getByText(ERROR_COPY.notFound)).toBeTruthy();
    await user.click(within(main).getByRole('button', { name: DIALOG_TITLES.browseChannels }));
    expect(screen.getByRole('dialog', { name: DIALOG_TITLES.browseChannels })).toBeTruthy();
  });

  it('compact: 같은 안내 + 「채널 찾기」 화면, 「뒤로」는 공간 목록', async () => {
    const user = userEvent.setup();
    open(390, `/c/${MISSING}`, withBrowse(seed()));
    const main = screen.getByRole('main');
    expect(within(main).getByText(ERROR_COPY.notFound)).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '공간' })).toBeNull();
    await user.click(within(main).getByRole('button', { name: '뒤로' }));
    expect(screen.queryByRole('main')).toBeNull();
    expect(screen.getByRole('navigation', { name: '공간' })).toBeTruthy();

    cleanup();
    open(390, `/c/${MISSING}`, withBrowse(seed()));
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: DIALOG_TITLES.browseChannels }));
    expect(screen.getByRole('region', { name: DIALOG_TITLES.browseChannels })).toBeTruthy();
  });

  it('목록 로딩 중·catch-up 중에는 안내를 내지 않는다(깜빡임 방지)', () => {
    open(1280, `/c/${MISSING}`, withBrowse(seed({ spaces: [], listState: 'loading' })));
    expect(screen.queryByText(ERROR_COPY.notFound)).toBeNull();
    cleanup();
    open(1280, `/c/${MISSING}`, withBrowse(seed({ connection: 'catching-up' })));
    expect(screen.queryByText(ERROR_COPY.notFound)).toBeNull();
  });

  it('목록에 있으면 기존 대화 화면(안내 없음)', () => {
    open(1280, `/c/${C1}`, withBrowse(seed()));
    expect(screen.queryByText(ERROR_COPY.notFound)).toBeNull();
    expect(within(screen.getByRole('main')).getByText('#general')).toBeTruthy();
  });

  it('채널 찾기 API가 없으면 안내만(버튼 없음)', () => {
    open(1280, `/c/${MISSING}`, createMemoryDataSource(seed()));
    const main = screen.getByRole('main');
    expect(within(main).getByText(ERROR_COPY.notFound)).toBeTruthy();
    expect(within(main).queryByRole('button')).toBeNull();
  });
});
