/**
 * W-19b CMP-26 BotBadge·봇 DM 고정(UI_STATES §2-3 「Jarvis DM」, §2-5 「봇 작성자」, DESIGN_REFERENCE §6-2 CMP-26).
 * 판정은 서버 결정값(`author_kind`·멤버 `kind`)만 — 표시 이름이 「Jarvis」인 사람은 배지가 없다.
 * DD 6-2에 W-19 봇 배지 지정 테스트 행이 없어 일반 이름으로 둔다.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '../../src/app/route.js';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource } from '../../src/data/http-source.js';
import type { Space } from '../../src/data';
import { Composer, MessageItem, type MessageItemData } from '../../src/features/conversation';
import { MemberAdmin } from '../../src/features/members';
import { Sidebar } from '../../src/features/sidebar';
import { DmStarter } from '../../src/features/spaces';
import { installViewport } from '../helpers/viewport.js';
import { FakeServer, ME, MemoryStorage, PEER, U, flush, summary } from '../sync/fake-server.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(flush);
};

const BOT = U(9);
const at = '2026-11-08T00:00:00Z';
const msg = (extra: Partial<MessageItemData>): MessageItemData => ({ id: 'm1', author: 'Jarvis', createdAt: at, body: '본문', authorId: BOT, replyCount: 0, ...extra });

function renderItem(message: MessageItemData) {
  return render(
    <ul>
      <MessageItem message={message} selfId={ME} onEdit={vi.fn()} onDelete={vi.fn()} onReply={vi.fn()} />
    </ul>,
  );
}

describe('메시지 작성자 배지(CMP-26)', () => {
  it('author_kind=bot → 이름 옆 「봇」 텍스트 배지가 보이고 메시지의 접근 가능한 이름에 포함된다', () => {
    renderItem(msg({ authorKind: 'bot' }));
    const item = screen.getByRole('listitem');
    const badge = item.querySelector('.bot-badge');
    expect(badge?.textContent).toBe('봇');
    // 배지는 작성자 이름과 같은 요소(같은 줄) 안 — flex-wrap 행에서 배지만 떨어지지 않는다.
    expect(badge?.parentElement?.className).toBe('msg-author');
    expect(item.getAttribute('aria-label')).toMatch(/^Jarvis 봇, /);
  });

  it('author_kind=human → 배지 없음, 판정은 author_kind만(표시 이름 「Jarvis」인 사람도 배지 없음)', () => {
    renderItem(msg({ authorKind: 'human' }));
    const item = screen.getByRole('listitem');
    expect(item.querySelector('.bot-badge')).toBeNull();
    expect(item.getAttribute('aria-label')).not.toContain('봇');
    cleanup();
    renderItem(msg({ author: '봇돌이' }));
    expect(screen.getByRole('listitem').querySelector('.bot-badge')).toBeNull();
  });

  it('봇 메시지에는 수정·삭제 버튼이 없다(작성자 아님) — 답글은 있다', () => {
    renderItem(msg({ authorKind: 'bot' }));
    const item = screen.getByRole('listitem');
    expect(within(item).queryByRole('button', { name: '수정' })).toBeNull();
    expect(within(item).queryByRole('button', { name: '삭제' })).toBeNull();
    expect(within(item).getByRole('button', { name: '답글' })).toBeTruthy();
  });
});

const space = (id: string, kind: Space['kind'], extra: Partial<Space> = {}): Space => ({
  id,
  kind,
  name: id,
  unreadCount: 0,
  mentionCount: 0,
  unreadThreadCount: 0,
  ...extra,
});

describe('봇 DM 고정·배지(사이드바)', () => {
  it('상대가 봇인 DM은 DM 목록 최상단, 그 안은 기존 순서 + 배지(접힘 접근 이름 포함)', () => {
    const spaces = [space('gen', 'channel'), space('kim', 'dm'), space('jarvis', 'dm', { bot: true }), space('lee', 'dm'), space('bot2', 'dm', { bot: true })];
    render(<Sidebar spaces={spaces} selectedId={null} collapsed={false} onSelect={() => {}} />);
    const dmIds = [...document.querySelectorAll('[data-space-id]')].map((b) => b.getAttribute('data-space-id')).filter((id) => id !== 'gen');
    expect(dmIds).toEqual(['jarvis', 'bot2', 'kim', 'lee']);
    const jarvis = document.querySelector('[data-space-id="jarvis"]');
    expect(jarvis?.querySelector('.bot-badge')?.textContent).toBe('봇');
    expect(document.querySelector('[data-space-id="kim"] .bot-badge')).toBeNull();
    cleanup();
    render(<Sidebar spaces={spaces} selectedId={null} collapsed onSelect={() => {}} />);
    expect(document.querySelector('[data-space-id="jarvis"]')?.getAttribute('aria-label')).toBe('jarvis 봇');
  });

  it('http-source: 목록 peer_kind=bot 상대 DM에만 bot 표시가 붙어 최상단에 고정된다(표시 이름 무관)', async () => {
    installViewport(1280);
    const server = new FakeServer();
    server.on('GET /api/members', () => ({
      status: 200,
      body: {
        members: [
          { id: ME, display_name: 'A', role: 'owner', kind: 'human' },
          { id: PEER, display_name: 'Jarvis', role: 'member', kind: 'human' },
          { id: BOT, display_name: '비서', role: 'member', kind: 'bot' },
        ],
      },
    }));
    server.on('GET /api/conversations', () => ({
      status: 200,
      body: {
        conversations: [
          summary(),
          summary({ id: U(20), kind: 'dm', name: null, peer_user_id: PEER, peer_kind: 'human' }),
          summary({ id: U(21), kind: 'dm', name: null, peer_user_id: BOT, peer_kind: 'bot' }),
        ],
        next_cursor: null,
      },
    }));
    const storage = new MemoryStorage();
    render(
      <LiveApp
        fetch={server.fetch}
        history={createMemoryHistory('/')}
        replacePath={() => undefined}
        readHash={() => ''}
        createSource={(deps) =>
          createHttpDataSource({ ...deps, wsUrl: 'wss://oms.test/api/ws', createSocket: server.createSocket, storage, isOnline: () => true, setTimer: () => 0, clearTimer: () => undefined })
        }
      />,
    );
    await settle();
    const dms = [...document.querySelectorAll('[data-space-id]')].filter((b) => b.getAttribute('data-space-id') !== summary().id);
    expect(dms.map((b) => b.querySelector('.space-name')?.textContent)).toEqual(['비서', 'Jarvis']);
    expect(dms[0]?.querySelector('.bot-badge')).not.toBeNull();
    expect(dms[1]?.querySelector('.bot-badge')).toBeNull();
  });

  it('W-22b(Codex W-19b P2): 비활성 봇(GET /api/members에 없음)도 peer_kind=bot이면 배지·최상단 고정 유지', async () => {
    installViewport(1280);
    const server = new FakeServer();
    server.on('GET /api/members', () => ({
      status: 200,
      body: {
        members: [
          { id: ME, display_name: 'A', role: 'owner', kind: 'human' },
          { id: PEER, display_name: 'Jarvis', role: 'member', kind: 'human' },
        ],
      },
    }));
    server.on('GET /api/conversations', () => ({
      status: 200,
      body: {
        conversations: [
          summary(),
          summary({ id: U(20), kind: 'dm', name: null, peer_user_id: PEER, peer_kind: 'human' }),
          summary({ id: U(21), kind: 'dm', name: null, peer_user_id: BOT, peer_kind: 'bot' }),
        ],
        next_cursor: null,
      },
    }));
    const storage = new MemoryStorage();
    render(
      <LiveApp
        fetch={server.fetch}
        history={createMemoryHistory('/')}
        replacePath={() => undefined}
        readHash={() => ''}
        createSource={(deps) =>
          createHttpDataSource({ ...deps, wsUrl: 'wss://oms.test/api/ws', createSocket: server.createSocket, storage, isOnline: () => true, setTimer: () => 0, clearTimer: () => undefined })
        }
      />,
    );
    await settle();
    const dms = [...document.querySelectorAll('[data-space-id]')].filter((b) => b.getAttribute('data-space-id') !== summary().id);
    expect(dms.map((b) => b.querySelector('.bot-badge') !== null)).toEqual([true, false]);
    expect(dms[1]?.querySelector('.space-name')?.textContent).toBe('Jarvis');
    expect(dms[0]?.querySelector('.bot-badge')).not.toBeNull();
    expect(dms[1]?.querySelector('.bot-badge')).toBeNull();
  });
});

const members = [
  { id: ME, displayName: 'A', role: 'owner' as const, kind: 'human' as const },
  { id: PEER, displayName: 'B', role: 'member' as const, kind: 'human' as const },
  { id: BOT, displayName: 'Jarvis', role: 'member' as const, kind: 'bot' as const },
];

describe('멤버 kind 사용처', () => {
  it('DM 시작 후보에 봇이 없다', async () => {
    render(
      <>
        <h2 id="t">DM 시작</h2>
        <DmStarter labelledBy="t" selfId={ME} load={async () => ({ ok: true, value: members })} start={vi.fn()} onStarted={vi.fn()} />
      </>,
    );
    await settle();
    const combo = screen.getByRole('combobox', { name: 'DM 시작' });
    expect(within(combo).getAllByRole('option').map((o) => o.textContent)).toEqual(['B']);
  });

  it('멤버 관리: 봇 행은 배지가 있고 「비활성화」 버튼이 없다(사람 행은 그대로)', async () => {
    installViewport(1280);
    render(<MemberAdmin account={{ id: ME, role: 'owner' }} load={async () => ({ ok: true, value: members })} createInvite={vi.fn()} deactivate={vi.fn()} origin="https://h.test" />);
    await settle();
    const main = screen.getByRole('main', { name: '멤버 관리' });
    const rows = within(main).getAllByRole('listitem');
    const botRow = rows.find((r) => r.textContent?.startsWith('Jarvis'));
    expect(botRow?.querySelector('.bot-badge')?.textContent).toBe('봇');
    expect(within(main).queryByRole('button', { name: 'Jarvis 비활성화' })).toBeNull();
    expect(within(main).getByRole('button', { name: 'B 비활성화' })).toBeTruthy();
    expect(rows.find((r) => r.textContent?.startsWith('B'))?.querySelector('.bot-badge')).toBeNull();
  });

  it('멘션 후보: 봇은 후보에 남고 배지가 붙는다', async () => {
    render(
      <Composer
        label="작성"
        placeholder="메시지"
        onSend={vi.fn()}
        mentions={{ candidates: [{ id: PEER, displayName: 'B' }, { id: BOT, displayName: 'Jarvis', bot: true }], selfId: ME }}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@' } });
    const options = screen.getAllByRole('option');
    const jarvis = options.find((o) => o.textContent?.startsWith('Jarvis'));
    expect(jarvis?.querySelector('.bot-badge')?.textContent).toBe('봇');
    expect(options.find((o) => o.textContent === 'B')).toBeTruthy();
  });
});

describe('반응형: 배지는 이름과 같은 줄, 넘침 0', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/ui/base.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.bot-badge \{([^}]*)\}/.exec(css)?.[1] ?? '';

  it('배지는 줄바꿈·축소하지 않고 기존 토큰만 쓴다(wide·compact 공통 규칙)', () => {
    expect(rule).toMatch(/white-space: nowrap/);
    expect(rule).toMatch(/flex: 0 0 auto/);
    expect(rule).toMatch(/display: inline-flex/);
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|\d+px(?!\s+solid)/i);
  });

  it.each([1280, 390])('폭 %ipx: 메시지·DM 항목에서 배지가 이름 요소와 같은 행 컨테이너 안에 있다', (width) => {
    installViewport(width);
    renderItem(msg({ authorKind: 'bot' }));
    expect(document.querySelector('.msg-author > .bot-badge')).not.toBeNull();
    cleanup();
    render(<Sidebar spaces={[space('jarvis', 'dm', { bot: true })]} selectedId={null} collapsed={false} compact={width === 390} onSelect={() => {}} />);
    const button = document.querySelector('[data-space-id="jarvis"]');
    expect(button?.querySelector(':scope > .bot-badge')).not.toBeNull();
    expect(button?.querySelector(':scope > .space-name')).not.toBeNull();
  });
});
