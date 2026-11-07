import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MessageBody } from '../../src/features/conversation/index.js';
import { bodyMentionsName, parseBody, type Block } from '../../src/features/conversation/render.js';

afterEach(cleanup);

function firstLine(blocks: readonly Block[]) {
  const block = blocks[0];
  if (block?.kind !== 'paragraph') throw new Error('paragraph expected');
  return block.lines[0];
}

describe('parseBody mention token', () => {
  it('names 없음/빈 배열 → 기존 출력과 동일', () => {
    const body = '@홍길동 안녕 https://example.com/@a\n```\n@홍길동\n```\n끝 @x';
    const base = parseBody(body);
    expect(parseBody(body, undefined)).toEqual(base);
    expect(parseBody(body, [])).toEqual(base);
    expect(parseBody(body, [''])).toEqual(base);
  });

  it('`@홍길동 안녕` → mention 인라인', () => {
    expect(firstLine(parseBody('@홍길동 안녕', ['홍길동']))).toEqual([
      { kind: 'mention', text: '@홍길동' },
      { kind: 'text', text: ' 안녕' },
    ]);
  });

  it('공백 뒤·문장부호 앞 멘션', () => {
    expect(firstLine(parseBody('안녕 @홍길동, 반가워', ['홍길동']))).toEqual([
      { kind: 'text', text: '안녕 ' },
      { kind: 'mention', text: '@홍길동' },
      { kind: 'text', text: ', 반가워' },
    ]);
  });

  it('`email@홍길동` → 앞 경계가 없어 멘션 아님', () => {
    expect(firstLine(parseBody('email@홍길동', ['홍길동']))).toEqual([{ kind: 'text', text: 'email@홍길동' }]);
  });

  // 선택: 이름 뒤가 글자(조사 등)면 멘션으로 보지 않는다. `@김철`이 `@김철수`를 오인하는 것을 막기 위한 대가.
  it('`@홍길동님` → 뒤가 글자라 멘션 아님', () => {
    expect(firstLine(parseBody('@홍길동님 안녕', ['홍길동']))).toEqual([{ kind: 'text', text: '@홍길동님 안녕' }]);
  });

  it('가장 긴 이름 우선', () => {
    expect(firstLine(parseBody('@김철수 hi', ['김철', '김철수']))).toEqual([
      { kind: 'mention', text: '@김철수' },
      { kind: 'text', text: ' hi' },
    ]);
    expect(firstLine(parseBody('@김철 hi', ['김철수', '김철']))?.[0]).toEqual({ kind: 'mention', text: '@김철' });
  });

  it('대소문자 구분, 목록에 없는 @foo는 일반 텍스트', () => {
    expect(firstLine(parseBody('@Bob @foo', ['bob']))).toEqual([{ kind: 'text', text: '@Bob @foo' }]);
  });

  it('URL 안·코드 블록 안 @이름은 그대로', () => {
    const blocks = parseBody('https://example.com/@홍길동 끝\n```\n@홍길동 x\n```', ['홍길동']);
    expect(blocks).toEqual(parseBody('https://example.com/@홍길동 끝\n```\n@홍길동 x\n```'));
  });

  it('링크 바로 뒤 text 인라인 첫 @는 경계 아님', () => {
    const line = firstLine(parseBody('(https://example.com)@홍길동', ['홍길동']));
    expect(line?.some((p) => p.kind === 'mention')).toBe(false);
  });
});

describe('MessageBody mention render', () => {
  it('msg-mention span으로 렌더', () => {
    const { container } = render(<MessageBody body="@홍길동 안녕" mentionNames={['홍길동']} />);
    const span = container.querySelector('span.msg-mention');
    expect(span?.textContent).toBe('@홍길동');
  });

  it('`<script>` 이름도 텍스트로만', () => {
    const name = '<script>alert(1)</script>';
    const body = `@${name} hi`;
    const { container } = render(<MessageBody body={body} mentionNames={[name]} />);
    expect(container.querySelectorAll('script').length).toBe(0);
    expect(container.querySelector('span.msg-mention')?.textContent).toBe(`@${name}`);
    expect(container.textContent).toBe(body);
  });
});

describe('bodyMentionsName', () => {
  it('경계 규칙을 따른다', () => {
    expect(bodyMentionsName('@홍길동 안녕', '홍길동')).toBe(true);
    expect(bodyMentionsName('안녕 @홍길동.', '홍길동')).toBe(true);
    expect(bodyMentionsName('email@홍길동', '홍길동')).toBe(false);
    expect(bodyMentionsName('@홍길동님', '홍길동')).toBe(false);
    expect(bodyMentionsName('@김철수', '김철')).toBe(false);
    expect(bodyMentionsName('```\n@홍길동\n```', '홍길동')).toBe(false);
    expect(bodyMentionsName('@홍길동', '')).toBe(false);
  });
});

describe('perf (F-1)', () => {
  it('4000자 `@a ` 반복 + 이름 100개 < 200ms', () => {
    const body = '@a '.repeat(1334).slice(0, 4000);
    const names = Array.from({ length: 100 }, (_, i) => `a${'b'.repeat(i)}`);
    const t0 = performance.now();
    const blocks = parseBody(body, names);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200);
    expect(firstLine(blocks)?.filter((p) => p.kind === 'mention').length).toBeGreaterThan(1000);
  });
});
