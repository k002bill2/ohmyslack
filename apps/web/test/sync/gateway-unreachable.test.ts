import { describe, expect, it } from 'vitest';
import { writeCheckpoint } from '../../src/features/sync';
import { CONV, ME, flush, setup } from './fake-server.js';

/**
 * W-16 F-8(QA-FR-SYNC-07): 리버스 프록시(Tailscale Serve) 뒤에서 서버가 죽으면 브라우저는 네트워크 오류가 아니라
 * 게이트웨이 응답(502/503/504)을 받는다. 이것도 서버 불가로 보고 UI_STATES C6 「연결이 끊겼습니다」로 판정한다.
 */
describe('게이트웨이 응답 = 서버 불가(F-8)', () => {
  it.each([502, 503, 504])('%i 반복 → 재시도 1회 후 끊김(offline)', async (status) => {
    const { server, ds, storage } = setup();
    writeCheckpoint(ME, 0, storage);
    server.on('GET /api/me', () => ({ status }));
    expect(await ds.resume()).toBe(false);
    expect(server.log.filter((l) => l === 'GET /api/me')).toHaveLength(2);
    expect(ds.getSnapshot().connection).toBe('offline');
  });

  it('500(서버 응답)은 끊김으로 보지 않는다', async () => {
    const { server, ds, storage } = setup();
    writeCheckpoint(ME, 0, storage);
    server.on('GET /api/me', () => ({ status: 500 }));
    expect(await ds.resume()).toBe(false);
    expect(ds.getSnapshot().connection).not.toBe('offline');
  });

  it('서버가 돌아오면 끊김에서 따라잡기를 거쳐 연결됨으로 복귀한다(C7)', async () => {
    const { server, ds, storage } = setup();
    writeCheckpoint(ME, 0, storage);
    const up = server.routes.get('GET /api/me');
    server.on('GET /api/me', () => ({ status: 502 }));
    expect(await ds.resume()).toBe(false);
    expect(ds.getSnapshot().connection).toBe('offline');

    if (up) server.on('GET /api/me', up);
    const states: string[] = [];
    const unsubscribe = ds.subscribe(() => {
      const now = ds.getSnapshot().connection;
      if (states.at(-1) !== now) states.push(now);
    });
    expect(await ds.resume()).toBe(true);
    unsubscribe();
    expect(states[0]).toBe('catching-up');
    expect(states.at(-1)).toBe('connected');
  });

  it('WS가 열린 채 일반 요청이 게이트웨이 응답으로 끊김이 된 뒤, 일반 요청 2xx 1회로 복귀 절차를 시작한다(C7, Codex r1 P2)', async () => {
    const { server, ds, storage } = setup();
    writeCheckpoint(ME, 0, storage);
    expect(await ds.resume()).toBe(true);
    const history = `GET /api/conversations/${CONV}/messages`;
    const ok = server.routes.get(history);
    server.on(history, () => ({ status: 502 }));
    for (let i = 0; i < 2; i++) {
      ds.open?.(CONV);
      await flush();
      ds.open?.(null);
    }
    expect(ds.getSnapshot().connection).toBe('offline');

    if (ok) server.on(history, ok);
    const meBefore = server.log.filter((l) => l === 'GET /api/me').length;
    ds.open?.(CONV);
    for (let i = 0; i < 6; i++) await flush();
    expect(server.log.filter((l) => l === 'GET /api/me').length).toBe(meBefore + 1);
    expect(ds.getSnapshot().connection).toBe('connected');
  });
});
