/**
 * QA iPhone r2(2026-11-14) 문서 「받기」 링크 — W1 standalone 직접 렌더 형식은 새 창, W2 파일명 단일 출처(서버 Content-Disposition).
 * 참고 출처: 일반 관념, 저장소 내부 문서.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentView } from '../../../../../packages/shared/src/index.js';
import { AttachmentList } from '../../../src/features/conversation/attachments/index.js';
import { downloadLinkTarget, isStandaloneDisplay, rendersInline } from '../../../src/features/conversation/attachments/download-link.js';
import { attachment } from './fixtures.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
  ])('standalone + %s → target=_blank rel=noopener', (mime, filename) => {
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
  ])('%s → 기존 속성 그대로(target·rel 없음)', (_n, on, mime, filename) => {
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
