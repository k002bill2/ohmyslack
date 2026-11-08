/** FR-MSG-10 제한된 서식(ADR-001 §3-f, UI_STATES §2-5) + FR-MSG-01 XSS·스킴 회귀. */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MessageBody } from '../../src/features/conversation/index.js';
import { bodyMentionsName, parseBody } from '../../src/features/conversation/render.js';

afterEach(cleanup);

function view(body: string, mentionNames?: readonly string[]): HTMLElement {
  const { container } = render(<MessageBody body={body} {...(mentionNames ? { mentionNames } : {})} />);
  return container.querySelector('.msg-body') as HTMLElement;
}

/** 렌더 결과에 스크립트·이벤트 핸들러 속성·비허용 스킴 href가 없는지(HTML 생성 0의 관찰 가능한 증거). */
function expectInert(root: HTMLElement): void {
  expect(root.querySelector('script, img, iframe, style')).toBeNull();
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) expect(attr.name.startsWith('on')).toBe(false);
  }
  for (const a of Array.from(root.querySelectorAll('a'))) expect(a.getAttribute('href')).toMatch(/^https?:\/\//);
}

describe('FR-MSG-10 제한된 서식', () => {
  it('FR-MSG-10 굵게·인라인 코드·목록·제목·http/https 마크다운 링크는 텍스트 노드로 표시되고 그 외 스킴과 닫히지 않은 기호는 원문 그대로이며 HTML을 만들지 않는다', () => {
    const body = [
      '# 오늘 브리핑',
      '**중요** 배포는 `pnpm verify` 후 [가이드](https://example.com/guide) 참고',
      '- 첫째',
      '* 둘째',
      '1. 하나',
      '2. 둘',
      '[나쁜](javascript:alert(1)) **닫히지 않음 `열린 코드 [x](',
      '[메일](mailto:a@b.co) [스크립트](javascript:void0)',
    ].join('\n');
    const root = view(body);
    const heading = root.querySelector('[role="heading"]') as HTMLElement;
    expect(heading.getAttribute('aria-level')).toBe('4');
    expect(heading.textContent).toBe('오늘 브리핑');
    expect(root.querySelector('strong:not(.msg-h)')?.textContent).toBe('중요');
    expect(root.querySelector('code.msg-inline-code')?.textContent).toBe('pnpm verify');
    const link = root.querySelector('a') as HTMLAnchorElement;
    expect(link.textContent).toBe('가이드');
    expect(link.getAttribute('href')).toBe('https://example.com/guide');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(Array.from(root.querySelectorAll('ul > li')).map((li) => li.textContent)).toEqual(['첫째', '둘째']);
    expect(Array.from(root.querySelectorAll('ol > li')).map((li) => li.textContent)).toEqual(['하나', '둘']);
    const last = root.querySelector('p.msg-paragraph:last-child') as HTMLElement;
    expect(last.textContent).toBe('[나쁜](javascript:alert(1)) **닫히지 않음 `열린 코드 [x](\n[메일](mailto:a@b.co) [스크립트](javascript:void0)'.replace('\n', ''));
    expect(root.querySelectorAll('a')).toHaveLength(1);
    expect(last.querySelector('a, strong, code')).toBeNull();
    expect(root.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expectInert(root);
  });

  it('FR-MSG-10 제목은 1–3단계만, 4단계·공백 없는 #은 원문', () => {
    const blocks = parseBody('## 둘\n### 셋\n#### 넷\n#태그');
    expect(blocks.slice(0, 2).map((b) => (b.kind === 'heading' ? b.level : 0))).toEqual([2, 3]);
    expect(blocks[2]).toEqual({ kind: 'paragraph', lines: [[{ kind: 'text', text: '#### 넷' }], [{ kind: 'text', text: '#태그' }]] });
    const root = view('### 셋');
    expect(root.querySelector('[role="heading"]')?.getAttribute('aria-level')).toBe('6');
  });

  it('FR-MSG-10 순서 목록 시작 번호와 목록 앞뒤 빈 줄', () => {
    expect(parseBody('앞\n\n3. a\n\n4. b\n\n뒤')).toEqual([
      { kind: 'paragraph', lines: [[{ kind: 'text', text: '앞' }]] },
      { kind: 'list', ordered: true, start: 3, items: [[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }]] },
      { kind: 'paragraph', lines: [[{ kind: 'text', text: '뒤' }]] },
    ]);
    expect(view('3. a').querySelector('ol')?.getAttribute('start')).toBe('3');
  });

  it('FR-MSG-10 닫히지 않은 기호·빈 내용·공백 경계는 원문 그대로 한 텍스트 노드', () => {
    for (const body of ['**x', '`x', '[x](', '**', '** x**', '**x **', '[x]()', '2 * 3 * 4']) {
      expect(parseBody(body)).toEqual([{ kind: 'paragraph', lines: [[{ kind: 'text', text: body }]] }]);
    }
    // 빈 링크 글자는 마크다운 링크가 아니다(URL은 기존 자동 링크).
    expect(parseBody('[](https://a.co)')[0]).toEqual({
      kind: 'paragraph',
      lines: [[{ kind: 'text', text: '[](' }, { kind: 'link', text: 'https://a.co', href: 'https://a.co/' }, { kind: 'text', text: ')' }]],
    });
    // 닫히지 않은 마크다운 링크 안의 URL은 기존(FR-MSG-01) 자동 링크로만 남는다 — 대괄호 글자는 원문.
    expect(parseBody('[x](https://a.co')).toEqual([
      { kind: 'paragraph', lines: [[{ kind: 'text', text: '[x](' }, { kind: 'link', text: 'https://a.co', href: 'https://a.co/' }]] },
    ]);
  });

  it('FR-MSG-10 중첩: 굵게 안 인라인 코드, 링크 글자 안 굵게만 — 그 이상은 원문', () => {
    expect(parseBody('**a `b` c**')[0]).toEqual({
      kind: 'paragraph',
      lines: [[{ kind: 'strong', children: [{ kind: 'text', text: 'a ' }, { kind: 'code', text: 'b' }, { kind: 'text', text: ' c' }] }]],
    });
    const link = view('[**굵은** 링크](https://a.co/x)').querySelector('a') as HTMLAnchorElement;
    expect(link.querySelector('strong')?.textContent).toBe('굵은');
    expect(link.textContent).toBe('굵은 링크');
    // 링크 글자 안 인라인 코드, 인라인 코드 안 굵게는 원문
    expect(view('[`x`](https://a.co)').querySelector('a')?.textContent).toBe('`x`');
    expect(view('`**x**`').querySelector('code')?.textContent).toBe('**x**');
  });

  it('FR-MSG-10 인라인 코드·링크 글자 안에서는 멘션·자동 링크 미적용, 굵게 안에서는 적용', () => {
    const root = view('`@홍길동 https://a.co` [@홍길동](https://b.co) **@홍길동 https://c.co**', ['홍길동']);
    expect(root.querySelector('code')?.textContent).toBe('@홍길동 https://a.co');
    expect(root.querySelector('code .msg-mention, code a')).toBeNull();
    expect(Array.from(root.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['https://b.co/', 'https://c.co/']);
    expect(Array.from(root.querySelectorAll('.msg-mention')).map((m) => m.closest('strong') !== null)).toEqual([true]);
    expect(bodyMentionsName('`@홍길동`', '홍길동')).toBe(false);
    expect(bodyMentionsName('[@홍길동](https://b.co)', '홍길동')).toBe(false);
    expect(bodyMentionsName('**@홍길동**', '홍길동')).toBe(true);
    expect(bodyMentionsName('- @홍길동 확인', '홍길동')).toBe(true);
  });

  it('FR-MSG-10 펜스 안은 서식 해석 0', () => {
    expect(parseBody('```\n# 제목\n**x** `y` [a](https://a.co)\n- b\n```')).toEqual([
      { kind: 'code', text: '# 제목\n**x** `y` [a](https://a.co)\n- b' },
    ]);
  });

  it('FR-MSG-10 XSS 회귀: script·javascript:·[x](javascript:)·**<img onerror>**는 텍스트로만', () => {
    const body = '<script>alert(1)</script>\njavascript:alert(1)\n[x](javascript:alert(1))\n**<img src=x onerror=alert(1)>**\n[y](data:text/html,x) [z](https://a.co"onmouseover=x)';
    const root = view(body);
    expectInert(root);
    // 마크다운 링크는 모두 거부되고, `"` 앞에서 끊긴 https 원문만 기존 자동 링크로 남는다.
    expect(Array.from(root.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['https://a.co/']);
    expect(root.querySelector('a')?.textContent).toBe('https://a.co');
    expect(root.querySelector('strong')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(root.textContent).toContain('<script>alert(1)</script>');
    expect(root.textContent).toContain('[x](javascript:alert(1))');
  });
});
