/**
 * 결정 3(2026-11-08) 시안 문구 채택: 작성기 placeholder(채널·DM·답글), 작성기 도움말(wide·medium 표시 / compact 숨김),
 * 「↳ 답글 n」, 멘션 팝오버 머리말·도움말. 기대값은 리터럴로 비교한다(상수 import 없음).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer, ThreadSummary } from '../../src/features/conversation/index.js';
import { AppShell } from '../../src/features/layout/AppShell.js';
import { ThreadPanel } from '../../src/features/thread/index.js';
import { memory, T0 } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

afterEach(cleanup);

const HINT = 'Enter 전송 · Shift+Enter 줄바꿈 · 한글 조합 중 Enter는 무시';

async function enter(width: number, spaceName: string) {
  installViewport(width);
  const user = userEvent.setup();
  render(<AppShell dataSource={memory()} />);
  await user.click(screen.getByRole('button', { name: spaceName }));
  return user;
}

describe('본문 작성기 placeholder', () => {
  it('채널: 「#general에 남기기」(# 한 번), 접근 이름은 그대로 「#general에 메시지 작성」', async () => {
    await enter(1440, 'general');
    const box = screen.getByRole('textbox', { name: '#general에 메시지 작성' });
    expect(box.getAttribute('placeholder')).toBe('#general에 남기기');
  });

  it('DM: 「홍길동에게 남기기」(# 없음)', async () => {
    await enter(1440, '홍길동');
    const box = screen.getByRole('textbox', { name: '홍길동에 메시지 작성' });
    expect(box.getAttribute('placeholder')).toBe('홍길동에게 남기기');
  });
});

describe('작성기 도움말', () => {
  it('wide: 작성기 아래 표시 + aria-describedby로 연결', async () => {
    await enter(1440, 'general');
    const box = screen.getByRole('textbox', { name: '#general에 메시지 작성' });
    const id = box.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    expect(document.getElementById(id as string)?.textContent).toBe(HINT);
    expect(box.closest('.composer')?.querySelector('.composer-hint')?.textContent).toBe(HINT);
  });

  it('medium: 표시', async () => {
    await enter(900, 'general');
    const box = screen.getByRole('textbox', { name: '#general에 메시지 작성' });
    expect(document.getElementById(box.getAttribute('aria-describedby') as string)?.textContent).toBe(HINT);
  });

  it('compact: 렌더하지 않고 aria-describedby도 없음', async () => {
    await enter(400, 'general');
    const box = screen.getByRole('textbox', { name: '#general에 메시지 작성' });
    expect(box.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('답글 작성기: wide 표시·연결, compact 숨김', () => {
    const root = { id: 'r1', author: '나', createdAt: T0, body: '원문' };
    const props = { root, replies: [], onClose: vi.fn(), onSend: vi.fn(), announce: vi.fn() };
    const { unmount } = render(<ThreadPanel variant="wide" {...props} />);
    const box = screen.getByRole('textbox', { name: '답글 작성' });
    expect(box.getAttribute('placeholder')).toBe('답글 남기기');
    expect(document.getElementById(box.getAttribute('aria-describedby') as string)?.textContent).toBe(HINT);
    unmount();
    render(<ThreadPanel variant="compact" {...props} />);
    expect(screen.getByRole('textbox', { name: '답글 작성' }).getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByText(HINT)).toBeNull();
  });
});

describe('스레드 요약 「↳ 답글 n」', () => {
  it('보이는 글자 「↳ 답글 3」, ↳는 aria-hidden 한 번, 접근 이름 「답글 3」', () => {
    render(<ThreadSummary rootId="m1" count={3} unread={false} holding={false} onOpen={vi.fn()} />);
    const button = screen.getByRole('button', { name: '답글 3' });
    expect(button.textContent?.replace(/\s+/g, ' ').trim()).toBe('↳ 답글 3');
    const hidden = button.querySelectorAll('[aria-hidden="true"]');
    expect(Array.from(hidden).filter((n) => n.textContent?.includes('↳'))).toHaveLength(1);
    expect(button.textContent?.split('↳')).toHaveLength(2);
  });
});

describe('멘션 팝오버 머리말·도움말', () => {
  const CANDS = [
    { id: 'me', displayName: '나' },
    { id: 'u-bob', displayName: 'Bob' },
    { id: 'u-bora', displayName: '보라' },
  ];
  function open(scope?: 'channel' | 'dm') {
    render(<Composer label="작성" onSend={vi.fn()} mentions={{ candidates: CANDS, selfId: 'me' }} {...(scope === undefined ? {} : { mentionScope: scope })} />);
    const box = screen.getByLabelText('작성') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '@' } });
    return box;
  }

  it('채널(기본): 「이 채널의 멤버」·「↑↓ 이동 · Enter 선택 · Esc 닫기」 — listbox 밖, 옵션 수 그대로', () => {
    open();
    const listbox = screen.getByRole('listbox');
    expect(screen.getByText('이 채널의 멤버')).toBeTruthy();
    expect(screen.getByText('↑↓ 이동 · Enter 선택 · Esc 닫기')).toBeTruthy();
    expect(listbox.textContent).not.toMatch(/이 채널의 멤버|Esc 닫기/);
    expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual(['Bob', '보라']);
    expect(Array.from(listbox.children).every((c) => c.getAttribute('role') === 'option')).toBe(true);
  });

  it('DM: 「이 대화의 멤버」', () => {
    open('dm');
    expect(screen.getByText('이 대화의 멤버')).toBeTruthy();
    expect(screen.queryByText('이 채널의 멤버')).toBeNull();
  });

  it('키보드 이동은 옵션만 순환(머리말·도움말 건너뜀), aria-activedescendant는 옵션 id', () => {
    const box = open();
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    const opts = screen.getAllByRole('option');
    expect(opts[1]?.getAttribute('aria-selected')).toBe('true');
    expect(box.getAttribute('aria-activedescendant')).toBe(opts[1]?.id);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(opts[0]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByText('이 채널의 멤버')).toBeNull();
  });

  it('머리말·도움말을 눌러도 작성기 포커스를 빼앗지 않는다(mousedown 기본 동작 취소)', () => {
    open();
    expect(fireEvent.mouseDown(screen.getByText('이 채널의 멤버'))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByText('↑↓ 이동 · Enter 선택 · Esc 닫기'))).toBe(false);
  });

  it('결과 없음 문구는 현행 유지', () => {
    const box = open();
    fireEvent.change(box, { target: { value: '@zz' } });
    expect(screen.getByText('일치하는 참여자가 없습니다')).toBeTruthy();
    expect(screen.getByText('이 채널의 멤버')).toBeTruthy();
  });
});

describe('앱 시나리오: 채널 진입 → placeholder → 스레드 열기 → 답글 placeholder', () => {
  it('실제 AppShell + 메모리 DataSource', async () => {
    const user = await enter(1440, 'general');
    expect(screen.getByRole('textbox', { name: '#general에 메시지 작성' }).getAttribute('placeholder')).toBe('#general에 남기기');
    await user.click(screen.getByRole('button', { name: '답글 1' }));
    const reply = await screen.findByRole('textbox', { name: '답글 작성' });
    expect(reply.getAttribute('placeholder')).toBe('답글 남기기');
  });
});

describe('금지어 가드: 웹 소스에 옛 placeholder 문구 없음', () => {
  // jsdom 환경이라 import.meta.url이 file:이 아니다 — vitest 루트(apps/web) 기준.
  const SRC = join(process.cwd(), 'src');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
    });

  it.each(['메시지 입력', '답글 입력'])('「%s」 0건(허용목록 없음)', (banned) => {
    const all = files(SRC);
    expect(all.some((f) => f.endsWith('Composer.tsx'))).toBe(true);
    const hits = all.filter((f) => readFileSync(f, 'utf8').includes(banned));
    expect(hits).toEqual([]);
  });
});
