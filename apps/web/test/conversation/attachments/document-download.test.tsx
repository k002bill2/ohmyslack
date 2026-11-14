/**
 * QA iPhone r2·r3(2026-11-14) 문서 「받기」 링크 — W2 파일명 단일 출처(서버 Content-Disposition), W3 클릭 때 HEAD로 만료 사전 확인,
 * r3: 모든 형식이 같은 링크(`download=""`, target 없음) — PDF·텍스트의 iOS 시트는 서버 octet-stream이 맡는다.
 * 참고 출처: 일반 관념, 저장소 내부 문서, 실기 관찰(dev/handoff/qa-iphone-r3-20261114).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentView } from '../../../../../packages/shared/src/index.js';
import { AttachmentList } from '../../../src/features/conversation/attachments/index.js';
import { EXPIRY_CHECK_TIMEOUT_MS, isAttachmentGone } from '../../../src/features/conversation/attachments/expiry-check.js';
import { ATTACHMENT_COPY } from '../../../src/ui/copy.js';
import { attachment } from './fixtures.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const doc = (over: Partial<AttachmentView> = {}) => attachment({ mime: DOCX, byte_size: 2048, filename: '분기 보고서.docx', has_macros: false, ...over });
const link = (c: HTMLElement) => c.querySelector('a.doc-download') as HTMLAnchorElement;

describe('W2 「받기」 파일명은 서버 헤더가 정한다', () => {
  it('download 속성은 값 없이 둔다(브라우저가 Content-Disposition 파일명을 쓴다)', () => {
    const { container } = render(<AttachmentList attachments={[doc({ filename: `${'가'.repeat(89)}.docm` })]} />);
    expect(link(container).hasAttribute('download')).toBe(true);
    expect(link(container).getAttribute('download')).toBe('');
  });
});

const FORMATS = [
  ['application/pdf', 'a.pdf'],
  ['text/plain', 'a.txt'],
  ['text/markdown', 'a.md'],
  ['text/csv', 'a.csv'],
  [DOCX, 'a.docx'],
  ['application/x-hwp', 'a.hwp'],
] as const;

/** jsdom에는 matchMedia가 없다 — 홈 화면 앱(standalone) 환경을 흉내 낸다(분기가 없어야 함을 보이려고). */
function stubStandalone() {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(display-mode: standalone)', media: q, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true });
}

describe('r3 모든 형식 「받기」는 같은 링크(standalone 분기 없음)', () => {
  afterEach(() => {
    Reflect.deleteProperty(window.navigator, 'standalone');
  });

  it.each(FORMATS.flatMap(([mime, filename]) => [
    [mime, filename, false],
    [mime, filename, true],
  ] as const))('%s (standalone=%s) → target·rel 없음, download 빈 값', (mime, filename, standalone) => {
    if (standalone) stubStandalone();
    const { container } = render(<AttachmentList attachments={[doc({ mime, filename })]} />);
    expect(link(container).hasAttribute('target')).toBe(false);
    expect(link(container).hasAttribute('rel')).toBe(false);
    expect(link(container).getAttribute('download')).toBe('');
    expect(link(container).getAttribute('href')).toMatch(/^\/api\/attachments\//);
  });
});

/** 링크에 도착한 click 이벤트마다 React 처리 뒤 기본 동작이 막혔는지 기록한다(document 버블 = React 루트 뒤). */
function recordClicks() {
  const log: boolean[] = [];
  const onClick = (e: Event) => {
    if ((e.target as Element).closest('a.doc-download') !== null) {
      log.push(e.defaultPrevented);
      e.preventDefault(); // jsdom 탐색 미구현 경고 방지(기록 뒤).
    }
  };
  document.addEventListener('click', onClick);
  return { log, stop: () => document.removeEventListener('click', onClick) };
}

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

describe('W3 「받기」 클릭 때 HEAD 만료 사전 확인', () => {
  it('만료 응답(404) → 기본 동작 취소 + 행이 만료 자리표시자(「받기」 숨김)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    const a = doc();
    const { container } = render(<AttachmentList attachments={[a]} />);
    const clicks = recordClicks();
    fireEvent.click(link(container));
    await flush();
    clicks.stop();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe(`/api/attachments/${a.id}`);
    expect(init?.method).toBe('HEAD');
    expect(init?.credentials).toBe('include');
    expect(clicks.log).toEqual([true]);
    expect(screen.getByText(ATTACHMENT_COPY.expired)).toBeTruthy();
    expect(container.querySelector('a.doc-download')).toBeNull();
    expect(container.querySelector('.doc-attachment-expired')).not.toBeNull();
  });

  it.each([
    ['200', () => Promise.resolve(new Response(null, { status: 200 }))],
    ['500', () => Promise.resolve(new Response(null, { status: 500 }))],
    ['401', () => Promise.resolve(new Response(null, { status: 401 }))],
    ['네트워크 오류', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('%s → 기존 링크 동작 그대로 진행(다시 클릭, 기본 동작 유지)', async (_n, impl) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(impl);
    const { container } = render(<AttachmentList attachments={[doc()]} />);
    const clicks = recordClicks();
    fireEvent.click(link(container));
    await flush();
    clicks.stop();
    expect(clicks.log).toEqual([true, false]);
    expect(link(container)).not.toBeNull();
    expect(screen.queryByText(ATTACHMENT_COPY.expired)).toBeNull();
  });

  it('응답이 3초 안에 없으면 중단하고 기존 링크 동작으로 진행', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_u, init) => new Promise((_r, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const { container } = render(<AttachmentList attachments={[doc()]} />);
    const clicks = recordClicks();
    fireEvent.click(link(container));
    await flush();
    expect(clicks.log).toEqual([true]);
    await act(async () => {
      vi.advanceTimersByTime(EXPIRY_CHECK_TIMEOUT_MS);
    });
    await flush();
    clicks.stop();
    expect(clicks.log).toEqual([true, false]);
  });

  it('확인 중 다시 누르면 요청을 겹치지 않는다', async () => {
    let resolve!: (r: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((r) => {
      resolve = r;
    }));
    const { container } = render(<AttachmentList attachments={[doc()]} />);
    const clicks = recordClicks();
    fireEvent.click(link(container));
    fireEvent.click(link(container));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    resolve(new Response(null, { status: 200 }));
    await flush();
    clicks.stop();
    expect(clicks.log).toEqual([true, true, false]);
  });

  it('보조키·가운데 버튼 클릭은 확인 없이 브라우저 기본 동작', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { container } = render(<AttachmentList attachments={[doc()]} />);
    const clicks = recordClicks();
    fireEvent.click(link(container), { metaKey: true });
    fireEvent.click(link(container), { ctrlKey: true });
    fireEvent.click(link(container), { button: 1 });
    clicks.stop();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(clicks.log).toEqual([false, false, false]);
  });

  it.each(FORMATS.map(([mime, filename]) => [mime, filename] as const))('standalone + %s → HEAD 1회 뒤 링크 동작 진행', async (mime, filename) => {
    stubStandalone();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const { container } = render(<AttachmentList attachments={[doc({ mime, filename })]} />);
    const clicks = recordClicks();
    fireEvent.click(link(container));
    await flush();
    clicks.stop();
    Reflect.deleteProperty(window.navigator, 'standalone');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('HEAD');
    expect(clicks.log).toEqual([true, false]);
  });

  it('isAttachmentGone: 404만 true, 본문 없는 HEAD 한 번', async () => {
    const calls: RequestInit[] = [];
    const f = (status: number) => (_u: string, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve({ status });
    };
    expect(await isAttachmentGone('/x', f(404))).toBe(true);
    expect(await isAttachmentGone('/x', f(200))).toBe(false);
    expect(await isAttachmentGone('/x', f(410))).toBe(false);
    expect(await isAttachmentGone('/x', () => Promise.reject(new Error('net')))).toBe(false);
    expect(calls.every((c) => c.method === 'HEAD' && c.body === undefined)).toBe(true);
  });
});
