import { act, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App.js';
import { createSwHandlers, parsePrecacheManifest } from '../../src/features/pwa';
import { createSessionBus, readCheckpoint, writeCheckpoint } from '../../src/features/sync';
import { memory } from '../helpers/fixtures.js';
import { fakeCacheStorage, fakeLifecycle, fetchEvent, request } from './fakes.js';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('FR-CLIENT-04 본문 지속 캐시 금지', () => {
  it('FR-CLIENT-04 SW·Cache Storage·IndexedDB·localStorage에 본문·인증 응답이 없고 숫자 checkpoint만 예외이며 API·WS는 SW를 우회하고 로그아웃 시 화면 본문 상태가 지워진다', async () => {
    // 1) SW: API·WS·인증 요청은 respondWith 없이 네트워크 직통, precache에는 /api가 들어갈 수 없다
    const { storage, stores } = fakeCacheStorage();
    const entries = parsePrecacheManifest([
      { url: '/assets/index-Ab12Cd34.js', revision: null },
      { url: '/api/messages', revision: null },
    ]);
    expect(entries.map((e) => e.url)).toEqual(['/assets/index-Ab12Cd34.js']);
    const fetcher = vi.fn(async () => new Response('net'));
    const sw = createSwHandlers({ storage, lifecycle: fakeLifecycle(), fetcher, entries, origin: 'https://app.test' });
    for (const req of [
      request('/api/messages'),
      request('/api/ws'),
      request('/api/auth/me'),
      request('/api/messages', { mode: 'navigate' }),
      request('/api/auth/login', { method: 'POST' }),
    ]) {
      const event = fetchEvent(req);
      sw.onFetch(event);
      expect(event.respondWith, req.url).not.toHaveBeenCalled();
    }
    const waits: Promise<unknown>[] = [];
    sw.onInstall({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    const cached = [...stores.values()].flatMap((s) => [...s.keys()]);
    expect(cached).toEqual(['/assets/index-Ab12Cd34.js']);

    // 2) 화면에 본문이 있는 상태에서 checkpoint만 저장된다(숫자만)
    const session = createSessionBus();
    render(createElement(App, { dataSource: memory(), session }));
    act(() => screen.getByRole('button', { name: 'general' }).click());
    expect(screen.getByText('안녕하세요')).toBeTruthy();
    writeCheckpoint('u1', 7);
    expect(() => writeCheckpoint('u1', '안녕하세요' as unknown as number)).toThrow(TypeError);
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? '');
    expect(keys).toEqual(['oms.cp.u1']);
    expect(localStorage.getItem('oms.cp.u1')).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(sessionStorage.length).toBe(0);
    expect(globalThis.indexedDB).toBeUndefined(); // jsdom; 실기 확인은 QA-FR-CLIENT-04

    // 3) 로그아웃: 화면 본문 상태와 checkpoint가 지워진다
    act(() => session.end('logout'));
    expect(screen.queryByText('안녕하세요')).toBeNull();
    expect(screen.queryByText('반갑습니다')).toBeNull();
    expect(screen.queryByRole('button', { name: 'general' })).toBeNull();
    expect(readCheckpoint('u1')).toBeNull();
    expect(localStorage.length).toBe(0);

    // 401도 같은 경로
    writeCheckpoint('u1', 8);
    act(() => session.end('unauthorized'));
    expect(readCheckpoint('u1')).toBeNull();
  });
});
