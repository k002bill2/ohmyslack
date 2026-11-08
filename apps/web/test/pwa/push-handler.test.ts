import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUSH_PAYLOAD_KEYS, pushPayloadSchema } from '../../../../packages/shared/src/push.js';
import { withThread } from '../../src/app/route.js';
import {
  createPushHandlers,
  GENERIC_PUSH_TAG,
  notificationFor,
  pushTargetUrl,
  SW_PUSH_COPY,
  toPushPayload,
  type ClientsLike,
  type WindowClientLike,
} from '../../src/features/pwa/push-notify.js';
import { PUSH_NOTIFICATION_COPY } from '../../src/ui/copy.js';

const ORIGIN = 'https://app.test';
const CONV = '11111111-1111-4111-8111-111111111111';
const MSG = '22222222-2222-4222-8222-222222222222';
const ROOT = '33333333-3333-4333-8333-333333333333';
const PAYLOAD = Object.freeze({ v: 1, kind: 'message', conversation_id: CONV, message_id: MSG, from_bot: false });

function data(value: unknown) {
  return { json: () => value };
}

function setup(windows: WindowClientLike[] = []) {
  const showNotification = vi.fn(async (_title: string, _options: object) => undefined);
  const clients: ClientsLike & { openWindow: ReturnType<typeof vi.fn> } = {
    matchAll: vi.fn(async () => windows),
    openWindow: vi.fn(async () => null),
  };
  const h = createPushHandlers({ showNotification, clients, origin: ORIGIN });
  return { h, showNotification, clients };
}

function pushEvent(d: { json(): unknown } | null) {
  const waits: Promise<unknown>[] = [];
  return { event: { data: d, waitUntil: vi.fn((p: Promise<unknown>) => void waits.push(p)) }, waits };
}

function clickEvent(url: unknown) {
  const waits: Promise<unknown>[] = [];
  const close = vi.fn();
  return { event: { notification: { data: { url }, close }, waitUntil: (p: Promise<unknown>) => void waits.push(p) }, waits, close };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FR-CLIENT-05 SW push 이벤트가 항상 알림을 표시하고 본문을 저장하지 않음 — features/pwa push 핸들러(TRD §6-2, UI_STATES §2-10 CMP-30)', () => {
  it('정상 payload: waitUntil(showNotification) — 고정 제목·본문, tag = conversation_id, data.url', async () => {
    const { h, showNotification } = setup();
    const { event, waits } = pushEvent(data(PAYLOAD));
    h.onPush(event);
    expect(event.waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waits);
    expect(showNotification).toHaveBeenCalledWith('ohmyslack', {
      body: '새 메시지가 있습니다',
      tag: CONV,
      data: { url: `/c/${CONV}#message-${MSG}` },
    });
  });

  it('봇 payload는 제목 「Jarvis」', async () => {
    const { h, showNotification } = setup();
    const { event, waits } = pushEvent(data({ ...PAYLOAD, from_bot: true }));
    h.onPush(event);
    await Promise.all(waits);
    expect(showNotification.mock.calls[0]?.[0]).toBe('Jarvis');
  });

  it.each([
    ['data 없음', null],
    ['JSON 아님', { json: () => { throw new SyntaxError('bad'); } }],
    ['계약 밖 키(body)', data({ ...PAYLOAD, body: '비밀 본문' })],
    ['uuid 아님', data({ ...PAYLOAD, conversation_id: 'c1' })],
    ['빈 객체', data({})],
  ])('잘못된 payload(%s)여도 일반 알림을 반드시 띄운다(iOS silent push 금지)', async (_name, d) => {
    const { h, showNotification } = setup();
    const { event, waits } = pushEvent(d);
    h.onPush(event);
    expect(event.waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waits);
    expect(showNotification).toHaveBeenCalledWith('ohmyslack', { body: '새 메시지가 있습니다', tag: GENERIC_PUSH_TAG, data: { url: '/' } });
  });

  it('알림에 payload 내용(본문 후보)이 들어가지 않고 저장소 API를 건드리지 않는다', async () => {
    const touched: string[] = [];
    const trap = (name: string) =>
      new Proxy({}, { get: () => { touched.push(name); return () => undefined; } });
    vi.stubGlobal('caches', trap('caches'));
    vi.stubGlobal('indexedDB', trap('indexedDB'));
    vi.stubGlobal('localStorage', trap('localStorage'));
    vi.stubGlobal('sessionStorage', trap('sessionStorage'));
    const { h, showNotification } = setup();
    for (const d of [data(PAYLOAD), data({ ...PAYLOAD, body: '비밀 본문', author: '홍길동' })]) {
      const { event, waits } = pushEvent(d);
      h.onPush(event);
      await Promise.all(waits);
    }
    expect(touched).toEqual([]);
    for (const [title, options] of showNotification.mock.calls) {
      expect(JSON.stringify([title, options])).not.toMatch(/비밀 본문|홍길동/);
      expect((options as { body: string }).body).toBe(SW_PUSH_COPY.body);
    }
  });

  it('notificationclick: 닫고, 열린 같은 출처 창을 focus + navigate(최상위 메시지)', async () => {
    const win = { url: `${ORIGIN}/c/other`, focus: vi.fn(async () => undefined), navigate: vi.fn(async () => undefined) };
    const foreign = { url: 'https://evil.test/', focus: vi.fn(async () => undefined), navigate: vi.fn(async () => undefined) };
    const { h, clients } = setup([foreign, win]);
    const { event, waits, close } = clickEvent(notificationFor(toPushPayload(PAYLOAD)).options.data.url);
    h.onNotificationClick(event);
    expect(close).toHaveBeenCalledTimes(1);
    await Promise.all(waits);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.navigate).toHaveBeenCalledWith(`${ORIGIN}/c/${CONV}#message-${MSG}`);
    expect(foreign.focus).not.toHaveBeenCalled();
    expect(clients.openWindow).not.toHaveBeenCalled();
  });

  it('notificationclick: 열린 창이 없으면 스레드 답글 URL(?thread=root#message-id)로 openWindow', async () => {
    const { h, clients } = setup();
    const url = notificationFor(toPushPayload({ ...PAYLOAD, thread_root_id: ROOT })).options.data.url;
    const { event, waits } = clickEvent(url);
    h.onNotificationClick(event);
    await Promise.all(waits);
    expect(clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/c/${CONV}?thread=${ROOT}#message-${MSG}`);
  });

  it('notificationclick: 다른 출처 url·형식 이상이면 루트(/)를 연다', async () => {
    const { h, clients } = setup();
    for (const url of ['https://evil.test/c/x', 42]) {
      const { event, waits } = clickEvent(url);
      h.onNotificationClick(event);
      await Promise.all(waits);
    }
    expect(clients.openWindow.mock.calls).toEqual([[`${ORIGIN}/`], [`${ORIGIN}/`]]);
  });

  it('SW 자체 판정·문구·URL은 shared 스키마·copy.ts·route.ts와 같다(sw.js 단일 스크립트라 복제)', () => {
    expect(SW_PUSH_COPY).toEqual(PUSH_NOTIFICATION_COPY);
    const fixtures: unknown[] = [
      PAYLOAD,
      { ...PAYLOAD, thread_root_id: ROOT },
      { ...PAYLOAD, from_bot: true },
      { ...PAYLOAD, extra: 1 },
      { ...PAYLOAD, v: 2 },
      { ...PAYLOAD, kind: 'other' },
      { ...PAYLOAD, message_id: 'not-a-uuid' },
      { ...PAYLOAD, thread_root_id: 'x' },
      { ...PAYLOAD, from_bot: 'yes' },
      { ...PAYLOAD, conversation_id: '11111111-1111-9111-8111-111111111111' },
      null,
      [],
      'str',
    ];
    for (const f of fixtures) {
      const z = pushPayloadSchema.safeParse(f);
      expect(toPushPayload(f)).toEqual(z.success ? z.data : null);
    }
    const parsed = toPushPayload({ ...PAYLOAD, thread_root_id: ROOT });
    expect(Object.keys(parsed ?? {}).every((k) => (PUSH_PAYLOAD_KEYS as readonly string[]).includes(k))).toBe(true);
    expect(pushTargetUrl(parsed)).toBe(`${withThread(`/c/${CONV}`, ROOT)}#message-${MSG}`);
  });
});
