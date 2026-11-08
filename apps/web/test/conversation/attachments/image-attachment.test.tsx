/** W-22 CMP-29 ImageAttachment·CMP-27 AttachmentList·MessageItem 배선(Jarvis ★ 임시 결정 Q-H2). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ATTACHMENTS_PER_MESSAGE_MAX } from '../../../../../packages/shared/src/index.js';
import { foldMessage } from '../../../src/data/fold.js';
import { MessageItem } from '../../../src/features/conversation';
import { AttachmentList, ImageAttachment } from '../../../src/features/conversation/attachments/index.js';
import { ATTACHMENT_COPY } from '../../../src/ui/copy.js';
import { message } from '../../sync/fake-server.js';
import { attachment } from './fixtures.js';

afterEach(cleanup);

describe('CMP-29 ImageAttachment', () => {
  it('썸네일: lazy img, alt 「첨부 이미지」, src = 다운로드 경로', () => {
    const a = attachment({ mime: 'image/png', width: 800, height: 600 });
    render(<ImageAttachment attachment={a} />);
    const img = screen.getByRole('img', { name: ATTACHMENT_COPY.imageAlt });
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('src')).toBe(`/api/attachments/${a.id}`);
  });

  it('탭하면 CMP-18 Dialog로 확대, 닫으면 사라진다', () => {
    const a = attachment({ mime: 'image/webp' });
    render(<ImageAttachment attachment={a} />);
    fireEvent.click(screen.getByRole('button', { name: ATTACHMENT_COPY.imageAlt }));
    const dialog = screen.getByRole('dialog', { name: ATTACHMENT_COPY.imageDialogTitle });
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe(`/api/attachments/${a.id}`);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Codex r1 P2: 확대 Dialog는 body 직속 portal — 앱의 다른 영역(형제)이 inert가 된다', () => {
    const a = attachment({ mime: 'image/png' });
    const { container } = render(
      <div>
        <button type="button">사이드바</button>
        <ImageAttachment attachment={a} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: ATTACHMENT_COPY.imageAlt }));
    const dialog = screen.getByRole('dialog', { name: ATTACHMENT_COPY.imageDialogTitle });
    expect(container.contains(dialog)).toBe(false);
    expect(container.inert).toBe(true);
  });

  it('만료 → 자리표시자, img 없음', () => {
    render(<ImageAttachment attachment={attachment({ mime: 'image/jpeg', expired: true })} />);
    expect(screen.getByText(ATTACHMENT_COPY.expired)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('불러오기 실패(404) → 깨진 이미지 대신 자리표시자, 다시 요청하지 않는다', () => {
    render(<ImageAttachment attachment={attachment({ mime: 'image/png' })} />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(ATTACHMENT_COPY.expired)).toBeTruthy();
  });
});

describe('CMP-27 AttachmentList', () => {
  it(`서버 순서 그대로, 최대 ${ATTACHMENTS_PER_MESSAGE_MAX}개`, () => {
    const list = [
      attachment({ mime: 'image/png' }),
      attachment({ mime: 'audio/mpeg' }),
      attachment({ mime: 'image/jpeg' }),
      attachment({ mime: 'audio/mpeg' }),
      attachment({ mime: 'image/webp' }),
    ];
    const { container } = render(<AttachmentList attachments={list} />);
    const srcs = [...container.querySelectorAll('img, audio')].map((el) => el.getAttribute('src'));
    expect(srcs).toEqual(list.slice(0, ATTACHMENTS_PER_MESSAGE_MAX).map((a) => `/api/attachments/${a.id}`));
  });

  it('빈 배열이면 아무것도 그리지 않는다', () => {
    const { container } = render(<AttachmentList attachments={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('봇 메시지의 mp3 첨부도 같은 컴포넌트로 재생 컨트롤을 그린다(브리핑)', () => {
    const a = attachment({ mime: 'audio/mpeg', duration_ms: 61_000 });
    const { container } = render(
      <ul>
        <MessageItem message={{ id: 'm1', author: 'Jarvis', authorKind: 'bot', createdAt: '2026-11-08T00:00:00Z', body: '오늘 브리핑', attachments: [a] }} />
      </ul>,
    );
    expect(container.querySelector('.bot-badge')).not.toBeNull();
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(`/api/attachments/${a.id}`);
    expect(screen.getByText('1:01')).toBeTruthy();
  });

  it('삭제 자리표시자에는 첨부를 그리지 않는다', () => {
    const { container } = render(
      <ul>
        <MessageItem message={{ id: 'm1', author: 'A', createdAt: '2026-11-08T00:00:00Z', body: '', deleted: true, attachments: [attachment()] }} />
      </ul>,
    );
    expect(container.querySelector('audio')).toBeNull();
  });

  it('fold: projection attachments → 화면 메시지 attachments(없거나 비면 키 없음)', () => {
    const a = attachment();
    const empty = { applied: new Map(), messages: new Map() };
    const withA = foldMessage(empty, 1, { ...message(1), author_kind: 'bot', attachments: [a] } as never, () => 'J');
    expect([...withA.messages.values()][0]?.attachments).toEqual([a]);
    const none = foldMessage(empty, 1, { ...message(2), author_kind: 'human', attachments: [] } as never, () => 'B');
    expect([...none.messages.values()][0]).not.toHaveProperty('attachments');
  });
});

describe('반응형: 390 폭 가로 넘침 0(CSS 단언)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/features/conversation/attachments/attachments.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  /** 선택자 목록에 `sel`이 독립 항목으로 들어 있는 규칙 본문을 모두 이어 붙인다(하위 결합자 규칙은 제외). */
  const rule = (sel: string) =>
    [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((m) => (m[1] ?? '').split(',').some((s) => s.trim() === sel))
      .map((m) => m[2])
      .join('\n');
  it.each(['.attachment-thumb', '.attachment-audio-player', '.attachment-list', '.attachment-image-open', '.composer-chip'])('%s → max-width 100 퍼센트', (sel) => {
    expect(rule(sel)).toMatch(/max-width:\s*100%/);
  });
  it('썸네일은 height auto(비율 유지), 칩 파일명은 말줄임', () => {
    expect(rule('.attachment-thumb')).toMatch(/height:\s*auto/);
    expect(rule('.composer-chip-name')).toMatch(/text-overflow:\s*ellipsis/);
  });
  /** `var(--x)`를 같은 규칙 묶음의 선언값으로 푼다(수치는 attachments.css 한 곳). */
  const resolveVar = (body: string, value: string) => value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? '?');
  const decl = (sel: string, prop: string) => {
    const body = rule(sel);
    const all = [...body.matchAll(new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`, 'g'))];
    return resolveVar(body, all.at(-1)?.[1]?.trim() ?? '');
  };
  it('W-22b: 썸네일은 최대 높이 320px·최대 폭 min(100%, 480px), contain(비율 유지)', () => {
    expect(decl('.attachment-thumb', 'max-height')).toBe('320px');
    expect(decl('.attachment-thumb', 'max-width')).toBe('min(100%, 480px)');
    expect(decl('.attachment-thumb', 'object-fit')).toBe('contain');
    expect(decl('.attachment-thumb', 'width')).toBe('auto');
    expect(decl('.attachment-thumb', 'height')).toBe('auto');
  });
  it('W-22b: 확대 이미지는 화면 안(최대 90vw·85vh) contain, Dialog도 90vw', () => {
    expect(decl('.attachment-full', 'max-height')).toBe('85vh');
    expect(decl('.attachment-full', 'max-width')).toBe('min(100%, 90vw)');
    expect(decl('.attachment-full', 'object-fit')).toBe('contain');
    expect(decl('.dialog:has(.attachment-full)', 'max-width')).toBe('90vw');
  });
});
