import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MessageBody } from '../../src/features/conversation/index.js';
import { linkify, parseBody, safeLinkHref } from '../../src/features/conversation/render.js';

afterEach(cleanup);

function renderBody(body: string): HTMLElement {
  return render(<MessageBody body={body} />).container;
}

/** DOM에 스크립트·이벤트 핸들러 속성·위험 href가 하나도 없음을 단언한다. */
function assertInert(root: HTMLElement): void {
  expect(root.querySelectorAll('script, iframe, object, embed, img, svg, style, form, input, math').length).toBe(0);
  for (const el of root.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      expect(attr.name.startsWith('on')).toBe(false);
      expect(attr.name).not.toBe('style');
      expect(attr.name).not.toBe('srcdoc');
    }
  }
  for (const a of root.querySelectorAll('a')) {
    expect(new URL(a.getAttribute('href') ?? '').protocol).toMatch(/^https?:$/);
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  }
}

const XSS_PAYLOADS: readonly (readonly [string, string])[] = [
  ['script 태그', '<script>alert(1)</script>'],
  ['img onerror', '<img src=x onerror=alert(1)>'],
  ['svg onload', '<svg onload=alert(1)>'],
  ['javascript: 스킴', 'javascript:alert(1)'],
  ['대소문자 섞은 JaVaScRiPt:', 'JaVaScRiPt:alert(document.cookie)'],
  ['data: text/html', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
  ['vbscript: 스킴', 'vbscript:msgbox(1)'],
  ['a href javascript', '<a href="javascript:alert(1)">클릭</a>'],
  ['iframe srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ['style 태그', '<style>body{display:none}</style>'],
  ['따옴표로 속성 탈출', 'https://example.com/"onmouseover="alert(1)'],
  ['코드 fence 안 script', '```\n<script>alert(1)</script>\n```'],
  ['file: 스킴', 'file:///etc/passwd'],
  ['엔티티 인코딩', '&lt;script&gt;alert(1)&lt;/script&gt;'],
];

describe('FR-MSG-01 한글·줄바꿈·http/https 링크·코드 블록은 표시되고 raw HTML·스크립트·그 외 스킴은 실행되지 않는다', () => {
  it('한글 본문을 텍스트 그대로 표시한다', () => {
    const root = renderBody('안녕하세요, 회의는 오후 3시입니다.');
    expect(root.textContent).toBe('안녕하세요, 회의는 오후 3시입니다.');
  });

  it('줄바꿈을 <br>로 표시하고 텍스트는 보존한다', () => {
    const root = renderBody('첫 줄\n둘째 줄\r\n셋째 줄');
    expect(root.querySelectorAll('br').length).toBe(2);
    expect(root.textContent).toBe('첫 줄둘째 줄셋째 줄');
  });

  it('http·https 링크를 noopener noreferrer 새 창 링크로 만든다', () => {
    const root = renderBody('자료 https://example.com/a?b=1 와 http://example.org.');
    const links = [...root.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a?b=1', 'http://example.org/']);
    expect(links.map((a) => a.textContent)).toEqual(['https://example.com/a?b=1', 'http://example.org']);
    expect(links.every((a) => a.getAttribute('rel') === 'noopener noreferrer')).toBe(true);
    expect(links.every((a) => a.getAttribute('target') === '_blank')).toBe(true);
    expect(root.textContent).toBe('자료 https://example.com/a?b=1 와 http://example.org.');
  });

  it('한글 바로 뒤에 붙은 링크도 인식한다', () => {
    const root = renderBody('링크:https://example.com');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com/');
  });

  it('코드 fence는 inert 코드 블록으로 표시하고 그 안의 링크·HTML은 해석하지 않는다', () => {
    const root = renderBody('보세요\n```ts\nconst a = "<b>x</b>";\nhttps://example.com\n```\n끝');
    const code = root.querySelector('pre > code');
    expect(code?.textContent).toBe('const a = "<b>x</b>";\nhttps://example.com');
    expect(root.querySelector('pre a, pre b')).toBeNull();
    expect(root.querySelectorAll('p').length).toBe(2);
  });

  it('닫히지 않은 fence는 일반 텍스트로 둔다', () => {
    expect(parseBody('```\n코드')).toEqual([
      { kind: 'paragraph', lines: [[{ kind: 'text', text: '```' }], [{ kind: 'text', text: '코드' }]] },
    ]);
  });

  it.each(XSS_PAYLOADS)('XSS 페이로드(%s)는 텍스트로만 표시되고 실행되지 않는다', (_name, payload) => {
    const root = renderBody(payload);
    assertInert(root);
    expect(root.textContent?.replace(/\n/g, '')).toBe(payload.replace(/```/g, '').replace(/\n/g, ''));
  });

  it('http·https 외 스킴은 링크로 만들지 않는다', () => {
    for (const s of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///x', 'mailto:a@b.c', 'ftp://x.y']) {
      expect(safeLinkHref(s)).toBeUndefined();
      expect(linkify(s).some((p) => p.kind === 'link')).toBe(false);
    }
    expect(safeLinkHref('https:')).toBeUndefined();
  });
});
