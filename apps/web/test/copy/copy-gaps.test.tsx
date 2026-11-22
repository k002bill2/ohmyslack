/** UI_STATES §9 채택분(COPY_GAPS G-n) 렌더 확인 — 기대값은 정본 문구 그대로(상수를 import하지 않고 리터럴로 비교). */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App.js';
import { LiveApp } from '../../src/LiveApp.js';
import { createHttpDataSource } from '../../src/data/http-source.js';
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, backoffDelay } from '../../src/data/realtime.js';
import { Composer, MessageStatus, type PendingMessage } from '../../src/features/conversation/index.js';
import { counterAnnouncement, counterText } from '../../src/features/conversation/Composer.js';
import { transition } from '../../src/features/conversation/send-status.js';
import { ThreadPanel } from '../../src/features/thread/index.js';
import * as copy from '../../src/ui/copy.js';
import { ErrorState } from '../../src/ui/ErrorState.js';
import { memory, seed, T0 } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';
import { FakeServer, MemoryStorage, flush } from '../sync/fake-server.js';

afterEach(cleanup);

const BASE: PendingMessage = {
  conversationId: 'c1', authorId: 'me', clientMessageId: 'cm-1', body: 'x', status: 'sending', serverEventSeen: false,
};

describe('G-20 「다시 작성」 완성 문장', () => {
  it.each([
    [400, '보낼 수 없는 내용입니다. 내용을 고쳐 다시 작성해 주세요.'],
    [409, '같은 메시지가 다른 내용으로 이미 처리되었습니다. 새로 다시 작성해 주세요.'],
  ])('HTTP %i → 사유별 문장 + 「삭제」, 「다시 시도」 없음', (status, text) => {
    const item = transition(BASE, { type: 'http-error', status });
    render(<MessageStatus item={item} onRetry={vi.fn()} onDiscard={vi.fn()} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(`${text}삭제`);
    expect(screen.queryByRole('button', { name: /다시 시도/ })).toBeNull();
  });
});

describe('G-34·G-35 전송 상태 라벨·버튼 분리', () => {
  it('저장 여부 확인 중: muted 라벨 + 「다시 시도」(접근 이름 정본) + 「목록에서 지우기」가 onDiscard를 부른다', () => {
    const onRetry = vi.fn();
    const onDiscard = vi.fn();
    render(<MessageStatus item={{ ...BASE, status: 'unknown' }} onRetry={onRetry} onDiscard={onDiscard} />);
    expect(screen.getByText('저장 여부 확인 중').className).toBe('msg-status-label');
    fireEvent.click(screen.getByRole('button', { name: '저장 여부 확인 중 · 다시 시도' }));
    fireEvent.click(screen.getByRole('button', { name: '목록에서 지우기' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('전송 실패: 라벨 「전송 실패」 + 버튼 「다시 시도」(접근 이름 「전송 실패 · 다시 시도」) + 「삭제」', () => {
    render(<MessageStatus item={{ ...BASE, status: 'failed', failure: 'retryable' }} onRetry={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toBe('전송 실패다시 시도삭제');
    expect(screen.getByRole('button', { name: '전송 실패 · 다시 시도' }).textContent).toBe('다시 시도');
  });
});

describe('G-28·G-29·G-30 작성기', () => {
  it('G-30 카운터: 3,800 미만 없음, 3,800–4,000 「n자 남음」, 초과 「n자 초과」', () => {
    expect(counterText(3_799, 4_000)).toBeNull();
    expect(counterText(3_812, 4_000)).toBe('188자 남음');
    expect(counterText(4_000, 4_000)).toBe('0자 남음');
    expect(counterText(5_234, 4_000)).toBe('1,234자 초과');
  });

  it('G-30 알림은 3,800·3,900·4,000 지점에서만 바뀌고, 초과면 정본 상한 문구', () => {
    expect(counterAnnouncement(3_799, 4_000)).toBe('');
    expect(counterAnnouncement(3_800, 4_000)).toBe('200자 남음');
    expect(counterAnnouncement(3_899, 4_000)).toBe('200자 남음');
    expect(counterAnnouncement(3_900, 4_000)).toBe('100자 남음');
    expect(counterAnnouncement(4_000, 4_000)).toBe('0자 남음');
    expect(counterAnnouncement(4_001, 4_000)).toBe('4,000자까지 입력할 수 있습니다');
  });

  it('G-30 화면: 카운터와 초과 시 정본 상한 문구 + 초과 수', () => {
    render(<Composer label="작성기" onSend={vi.fn()} />);
    const box = screen.getByRole('textbox', { name: '작성기' });
    fireEvent.change(box, { target: { value: '가'.repeat(3_812) } });
    expect(screen.getByText('188자 남음')).toBeTruthy();
    fireEvent.change(box, { target: { value: '가'.repeat(4_005) } });
    expect(screen.getByText('5자 초과')).toBeTruthy();
    expect(screen.getByText('4,000자까지 입력할 수 있습니다').getAttribute('aria-live')).toBe('polite');
  });

  it('G-28·G-29 본문 작성기: 이름 「#general에 메시지 작성」, placeholder 「#general에 남기기」(결정 3)', async () => {
    installViewport(1400);
    const user = userEvent.setup();
    render(<App dataSource={memory(seed())} />);
    await user.click(screen.getByRole('button', { name: 'general' }));
    const box = screen.getByRole('textbox', { name: '#general에 메시지 작성' });
    expect(box.getAttribute('placeholder')).toBe('#general에 남기기');
    expect(document.body.textContent).not.toMatch(/Workspace|워크스페이스/);
  });

  it('G-22·G-28·G-29 스레드: 빈 상태 「첫 답글을 남겨 보세요」, 이름 「답글 작성」, placeholder 「답글 남기기」(결정 3)', () => {
    render(
      <ThreadPanel
        variant="wide"
        root={{ id: 'r1', author: '나', createdAt: T0, body: '원문' }}
        replies={[]}
        onClose={vi.fn()}
        onSend={vi.fn()}
        announce={vi.fn()}
      />,
    );
    expect(screen.getByText('첫 답글을 남겨 보세요')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '답글 작성' }).getAttribute('placeholder')).toBe('답글 남기기');
  });
});

describe('G-37 재접속 백오프', () => {
  it('1초 시작·2배·상한 30초: 1·2·4·8·16·30·30초', () => {
    expect(BACKOFF_BASE_MS).toBe(1_000);
    expect(BACKOFF_MAX_MS).toBe(30_000);
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(backoffDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });
});

describe('G-19 ErrorState', () => {
  it('원인 1문장 + 「다시 시도」(onRetry 있을 때만)', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorState message="서버에 연결하지 못했습니다." onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<ErrorState message="입력 내용을 처리할 수 없습니다. 내용을 확인해 주세요." />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('입력 내용을 처리할 수 없습니다. 내용을 확인해 주세요.');
  });
});

describe('컴포넌트 미구현 항목의 문구 상수(정본 그대로)', () => {
  it('G-19·G-21·G-23–G-27·G-31·G-33', () => {
    expect(copy.ERROR_COPY).toEqual({
      network: '서버에 연결하지 못했습니다.',
      timeout: '서버 응답이 늦어 확인하지 못했습니다.',
      server: '서버에 문제가 생겨 처리하지 못했습니다.',
      rateLimited: '요청이 많아 잠시 처리할 수 없습니다.',
      badRequest: '입력 내용을 처리할 수 없습니다. 내용을 확인해 주세요.',
      notFound: '찾을 수 없거나 볼 수 없는 항목입니다. 목록을 새로 고쳐 주세요.',
      refreshList: '목록 새로 고침',
    });
    expect(copy.MENTION_EMPTY_TEXT).toBe('일치하는 참여자가 없습니다');
    expect(copy.LEAVE_CHANNEL_COPY).toEqual({
      title: '채널 나가기',
      body: '나가면 이 채널의 새 메시지를 받지 않습니다. 다시 참여하면 이력을 볼 수 있습니다.',
      confirm: '나가기',
    });
    expect(copy.DELETE_MESSAGE_COPY).toEqual({
      title: '메시지 삭제',
      body: '삭제하면 모든 참여자에게 「삭제된 메시지입니다」로 보이며 되돌릴 수 없습니다.',
      confirm: '삭제',
    });
    expect(copy.CANCEL_LABEL).toBe('취소');
    expect(copy.CHANNEL_NAME_TAKEN_TEXT).toBe('같은 이름의 채널이 이미 있습니다. 다른 이름을 입력해 주세요.');
    expect(copy.DIALOG_TITLES).toEqual({
      createChannel: '채널 만들기',
      browseChannels: '채널 찾기',
      startDm: 'DM 시작',
      createInvite: '초대 링크 만들기',
      leaveChannel: '채널 나가기',
      deleteChannel: '채널 삭제',
      deactivateMember: '멤버 비활성화',
      deleteMessage: '메시지 삭제',
      shortcuts: '키보드 단축키',
      notifications: '알림',
    });
    expect(copy.HEADER_MENU_COPY.notifications).toBe('알림 설정…');
    expect(copy.MEMBER_DEACTIVATE_COPY.rowButton).toBe('비활성화');
    expect(copy.MEMBER_DEACTIVATE_COPY.rowButtonName('홍길동')).toBe('홍길동 비활성화');
    expect(copy.MEMBER_DEACTIVATE_COPY.confirm).toBe('멤버 비활성화');
    expect(copy.SIDEBAR_TOGGLE_COPY).toEqual({ collapse: '사이드바 접기', expand: '사이드바 펼치기' });
    expect(copy.SPACE_SWITCHER_COPY).toEqual({
      title: '공간 이동',
      inputLabel: '채널 또는 DM 이름',
      empty: '일치하는 채널이나 DM이 없습니다',
    });
    expect(copy.COLLAPSED_LABEL_SEPARATOR).toBe(', ');
    expect(copy.mentionCountLabel(99, 99)).toBe('멘션 99개');
    expect(copy.mentionCountLabel(100, 99)).toBe('멘션 99개 이상');
    expect(copy.APP_NAME).toBe('메신저');
  });

  it('렌더·상수 문자열에 「Workspace」「워크스페이스」가 없다', () => {
    expect(JSON.stringify(Object.values(copy).filter((v) => typeof v !== 'function'))).not.toMatch(/Workspace|워크스페이스/);
  });
});

describe('G-13 LiveApp 「로그인」 링크', () => {
  it('사용할 수 없는 초대에서 「로그인」을 누르면 주소를 /login으로 바꾸고 로그인 화면으로 간다', async () => {
    const server = new FakeServer();
    server.on('POST /api/invites/accept', () => ({ status: 400, body: { error: { code: 'invite_invalid', request_id: 'r' } } }));
    const paths: string[] = [];
    const storage = new MemoryStorage();
    render(
      <LiveApp
        fetch={server.fetch}
        readHash={() => '#t=tok'}
        clearHash={() => undefined}
        replacePath={(p) => paths.push(p)}
        createSource={(deps) =>
          createHttpDataSource({
            ...deps,
            wsUrl: 'wss://oms.test/api/ws',
            createSocket: server.createSocket,
            storage,
            isOnline: () => true,
            setTimer: () => 0,
            clearTimer: () => undefined,
          })
        }
      />,
    );
    fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'pw' } });
    fireEvent.change(screen.getByLabelText('표시 이름'), { target: { value: 'N' } });
    fireEvent.submit(screen.getByRole('button', { name: '수락' }).closest('form') as HTMLFormElement);
    for (let i = 0; i < 6; i += 1) await act(flush);
    expect(screen.getByText('이미 계정을 만들었다면 로그인해 주세요.')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: '로그인' }));
    expect(paths).toEqual(['/login']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('로그인');
    expect(screen.getByRole('button', { name: '로그인' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
