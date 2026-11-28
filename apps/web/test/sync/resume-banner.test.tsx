/**
 * FR-SYNC-07 컴포넌트 보조(DEV_DESIGN §6-2): 가시성 복귀 → 확인 중 표시 → 완료 후 해제, 서버 불가 시 끊김 표시.
 * 문구 정본: 디자인 §6(ConnectionBanner CONNECTION_TEXT). 가짜 fetch·WebSocket만 사용(BRIEF ★5).
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from '../../src/features/layout';
import { CONNECTION_TEXT, writeCheckpoint } from '../../src/features/sync';
import { CONV, ME, flush, setup } from './fake-server.js';

class FakeDoc extends EventTarget {
  visibilityState = 'visible';
  hide() {
    this.visibilityState = 'hidden';
    this.dispatchEvent(new Event('visibilitychange'));
  }
  show() {
    this.visibilityState = 'visible';
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

const RESUME_STEPS = /^(GET \/api\/me$|GET \/api\/sync\?|GET \/api\/conversations$|ws conversation\.subscribe)/;
const banner = () => screen.getByRole('status', { hidden: true });
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(flush);
};

afterEach(cleanup);

describe('FR-SYNC-07 복귀 배너(5분 이상 백그라운드 후 전경 복귀)', () => {
  async function connected() {
    const doc = new FakeDoc();
    // 계측 전송(숨김 → POST /api/metrics)은 복귀 절차가 아니다 — 요청 로그를 복귀 절차만으로 보도록 기록기를 비운다.
    const ctx = setup({ lifecycle: { doc, win: new EventTarget() }, metrics: { record: () => undefined } });
    writeCheckpoint(ME, 4, ctx.storage);
    render(<AppShell dataSource={ctx.ds} />);
    ctx.ds.open?.(CONV);
    await act(async () => {
      expect(await ctx.ds.start()).toBe(true);
    });
    expect(banner().getAttribute('data-state')).toBe('connected');
    return { ...ctx, doc };
  }

  it('복귀 → 「최신 상태 확인 중…」 → 인증·sync·목록·구독 순서 완료 후 배너 해제', async () => {
    const { server, ds, doc } = await connected();
    doc.hide();
    server.log.length = 0;
    server.autoAck = false; // 구독 ACK 전까지는 완료가 아니다
    act(() => doc.show()); // 5분 이상 숨김 후 복귀: 경과 시간과 무관하게 항상 catch-up(DD R-03)
    expect(banner().textContent).toBe(CONNECTION_TEXT['catching-up']);
    await settle();
    expect(banner().getAttribute('data-state')).toBe('catching-up');
    expect(server.log.filter((l) => RESUME_STEPS.test(l))).toEqual([
      'GET /api/me',
      'GET /api/sync?after=4',
      'GET /api/conversations',
      'ws conversation.subscribe',
    ]);
    act(() => server.socket.push({ type: 'conversation.subscribed', conversation_id: CONV, through_cursor: 4 }));
    await settle();
    expect(banner().getAttribute('data-state')).toBe('connected');
    expect(banner().textContent).not.toContain(CONNECTION_TEXT['catching-up']);
    expect(ds.getSnapshot().connection).toBe('connected');
  });

  it('복귀 시 서버 불가 → 「연결이 끊겼습니다…」, 최신(연결됨)으로 표시하지 않음', async () => {
    const { server, doc } = await connected();
    doc.hide();
    server.on('GET /api/me', () => 'network');
    act(() => doc.show());
    await settle();
    expect(banner().getAttribute('data-state')).toBe('offline');
    expect(banner().textContent).toBe(CONNECTION_TEXT.offline);
  });

  it('숨김 상태로 바뀌는 이벤트는 복귀 절차를 시작하지 않는다', async () => {
    const { server, doc } = await connected();
    server.log.length = 0;
    act(() => doc.hide());
    await settle();
    expect(server.log).toEqual([]);
    expect(banner().getAttribute('data-state')).toBe('connected');
  });
});
