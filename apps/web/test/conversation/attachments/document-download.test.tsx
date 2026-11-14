/**
 * QA iPhone r2(2026-11-14) 문서 「받기」 링크 — W1 standalone 직접 렌더 형식은 새 창, W2 파일명 단일 출처(서버 Content-Disposition),
 * W3 클릭 때 HEAD로 만료 사전 확인.
 * 참고 출처: 일반 관념, 저장소 내부 문서.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentView } from '../../../../../packages/shared/src/index.js';
import { AttachmentList } from '../../../src/features/conversation/attachments/index.js';
import { downloadLinkTarget, isStandaloneDisplay, rendersInline } from '../../../src/features/conversation/attachments/download-link.js';
import { EXPIRY_CHECK_TIMEOUT_MS, isAttachmentGone } from '../../../src/features/conversation/attachments/expiry-check.js';
import { ATTACHMENT_COPY } from '../../../src/ui/copy.js';
import { attachment } from './fixtures.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window.navigator, 'standalone');
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

/** jsdom에는 matchMedia가 없다 — standalone 질의만 참으로 돌려준다. */
function stubStandalone(on: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q === '(display-mode: standalone)', media: q, addEventListener() {}, removeEventListener() {} }));
}

describe('W1 standalone에서 iOS 직접 렌더 형식 「받기」는 새 창', () => {
  it.each([
    ['application/pdf', 'a.pdf'],
    ['text/plain', 'a.txt'],
    ['text/markdown', 'a.md'],
    ['text/csv', 'a.csv'],
  ] as const)('standalone + %s → target=_blank rel=noopener', (mime, filename) => {
    stubStandalone(true);
    const { container } = render(<AttachmentList attachments={[doc({ mime, filename })]} />);
    expect(link(container).getAttribute('target')).toBe('_blank');
    expect(link(container).getAttribute('rel')).toBe('noopener');
    expect(link(container).getAttribute('download')).toBe('');
  });

  it('iOS navigator.standalone === true 도 standalone으로 본다', () => {
    Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true });
    const { container } = render(<AttachmentList attachments={[doc({ mime: 'application/pdf', filename: 'a.pdf' })]} />);
    expect(link(container).getAttribute('target')).toBe('_blank');
  });

  it.each([
    ['비standalone + PDF', false, 'application/pdf', 'a.pdf'],
    ['standalone + docx', true, DOCX, 'a.docx'],
    ['standalone + hwp', true, 'application/x-hwp', 'a.hwp'],
  ] as const)('%s → 기존 속성 그대로(target·rel 없음)', (_n, on, mime, filename) => {
    stubStandalone(on);
    const { container } = render(<AttachmentList attachments={[doc({ mime, filename })]} />);
    expect(link(container).hasAttribute('target')).toBe(false);
    expect(link(container).hasAttribute('rel')).toBe(false);
    expect(link(container).getAttribute('href')).toMatch(/^\/api\/attachments\//);
  });

  it('matchMedia가 없는 환경은 일반 브라우저', () => {
    expect(isStandaloneDisplay({})).toBe(false);
    expect(isStandaloneDisplay({ matchMedia: () => ({ matches: true }) })).toBe(true);
    expect(isStandaloneDisplay({ navigator: { standalone: false }, matchMedia: () => ({ matches: false }) })).toBe(false);
  });

  it('판정 helper: 직접 렌더 형식은 PDF·텍스트 3종뿐', () => {
    expect(['application/pdf', 'text/plain', 'text/markdown', 'text/csv'].every(rendersInline)).toBe(true);
    expect(rendersInline(DOCX)).toBe(false);
    expect(downloadLinkTarget('application/pdf', false)).toEqual({});
    expect(downloadLinkTarget(DOCX, true)).toEqual({});
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
