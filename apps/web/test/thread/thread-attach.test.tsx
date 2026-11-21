/** 스레드 답글 작성기 첨부(「파일 첨부」 버튼·⌘V 붙여넣기) — 브리프 thread-attach 규칙 1~6. */
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentView } from '../../../../packages/shared/src/index.js';
import { App } from '../../src/App.js';
import type { ActionResult, DataSource, UploadAttachmentOptions } from '../../src/data/index.js';
import { ThreadPanel } from '../../src/features/thread';
import { ATTACHMENT_COPY, COMPOSER_COPY } from '../../src/ui/copy.js';
import { attachment } from '../conversation/attachments/fixtures.js';
import { T0, memory } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

afterEach(cleanup);

type Result = ActionResult<AttachmentView>;

function png(name = 'shot.png'): File {
  return new File([new Uint8Array(4)], name, { type: 'image/png' });
}

/** jsdom에는 DataTransfer가 없어 클립보드 모양만 흉내 낸다(composer-paste 테스트와 같은 모양). */
function clip(files: readonly File[]) {
  return {
    files: [...files],
    items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    getData: () => '',
  };
}

async function paste(box: HTMLElement, files: readonly File[]): Promise<boolean> {
  const ev = createEvent.paste(box, { clipboardData: clip(files) });
  await act(async () => {
    fireEvent(box, ev);
  });
  return ev.defaultPrevented;
}

function threadPanel(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.thread-panel');
  if (el === null) throw new Error('스레드 패널 없음');
  return el;
}

function mainComposer(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-composer="main"]');
  if (el === null) throw new Error('본문 작성기 없음');
  return el;
}

/** 메모리 데이터 소스 + 업로드·전송 기록. `hang`이면 업로드가 끝나지 않는다(취소 확인용). */
function mountShell(opts: { readonly hang?: boolean } = {}) {
  installViewport(1280);
  const base = memory();
  const done = attachment({ mime: 'image/png' });
  const uploads: { conversationId: string; file: Blob; signal: AbortSignal | undefined }[] = [];
  const send = vi.fn<DataSource['send']>((target, body, mentionUserIds, attachmentIds) => base.send(target, body, mentionUserIds, attachmentIds));
  const ds: DataSource = {
    ...base,
    send,
    uploadAttachment: (conversationId: string, file: Blob, options?: UploadAttachmentOptions) => {
      uploads.push({ conversationId, file, signal: options?.signal });
      return opts.hang === true ? new Promise<Result>(() => undefined) : Promise.resolve<Result>({ ok: true, value: done });
    },
  };
  render(<App dataSource={ds} />);
  return { send, uploads, done };
}

async function openThread(rootId: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'general' }));
  });
  const reply = document.querySelector<HTMLElement>(`[data-reply-for="${rootId}"]`);
  if (reply === null) throw new Error(`답글 버튼 없음: ${rootId}`);
  await act(async () => {
    fireEvent.click(reply);
  });
}

describe('스레드 답글 작성기 첨부(AppShell 배선)', () => {
  it('(a) 답글 작성기에 「파일 첨부」 버튼이 있다', async () => {
    mountShell();
    await openThread('m1');
    expect(within(threadPanel()).getByRole('button', { name: ATTACHMENT_COPY.attach })).toBeTruthy();
  });

  it('(b) 답글 작성기 PNG 붙여넣기 → 칩·업로드(스레드가 속한 대화 id)', async () => {
    const { uploads } = mountShell();
    await openThread('m1');
    const box = within(threadPanel()).getByRole('textbox', { name: COMPOSER_COPY.replyLabel });
    expect(await paste(box, [png()])).toBe(true);
    expect(within(threadPanel()).getByTitle('shot.png')).toBeTruthy();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.conversationId).toBe('c1');
  });

  it('(d) 본문 작성기 칩과 답글 작성기 칩이 섞이지 않는다', async () => {
    mountShell();
    await openThread('m1');
    await paste(within(threadPanel()).getByRole('textbox', { name: COMPOSER_COPY.replyLabel }), [png('reply.png')]);
    await paste(within(mainComposer()).getByRole('textbox'), [png('main.png')]);
    expect(within(threadPanel()).getByTitle('reply.png')).toBeTruthy();
    expect(within(threadPanel()).queryByTitle('main.png')).toBeNull();
    expect(within(mainComposer()).getByTitle('main.png')).toBeTruthy();
    expect(within(mainComposer()).queryByTitle('reply.png')).toBeNull();
  });

  it('(e) 답글 전송 → send({conversationId, rootId}, body, undefined, [첨부 id]) 후 답글 칩 비움', async () => {
    const { send, done } = mountShell();
    await openThread('m1');
    const box = within(threadPanel()).getByRole('textbox', { name: COMPOSER_COPY.replyLabel });
    await paste(box, [png()]);
    fireEvent.change(box, { target: { value: '스크린샷' } });
    await act(async () => {
      fireEvent.click(within(threadPanel()).getByRole('button', { name: '전송' }));
    });
    expect(send).toHaveBeenCalledWith({ conversationId: 'c1', rootId: 'm1' }, '스크린샷', undefined, [done.id]);
    expect(within(threadPanel()).queryByTitle('shot.png')).toBeNull();
  });

  it('스레드를 닫으면 그 root 키의 진행 중 업로드를 끊는다', async () => {
    const { uploads } = mountShell({ hang: true });
    await openThread('m1');
    await paste(within(threadPanel()).getByRole('textbox', { name: COMPOSER_COPY.replyLabel }), [png()]);
    expect(uploads[0]?.signal?.aborted).toBe(false);
    await act(async () => {
      fireEvent.click(within(threadPanel()).getByRole('button', { name: '닫기' }));
    });
    expect(uploads[0]?.signal?.aborted).toBe(true);
    await openThread('m1');
    expect(within(threadPanel()).queryByTitle('shot.png')).toBeNull();
  });

  it('다른 root로 바꾸면 이전 root 키의 진행 중 업로드를 끊는다', async () => {
    const { uploads } = mountShell({ hang: true });
    await openThread('m1');
    await paste(within(threadPanel()).getByRole('textbox', { name: COMPOSER_COPY.replyLabel }), [png()]);
    const reply = document.querySelector<HTMLElement>('[data-reply-for="m2"]');
    await act(async () => {
      fireEvent.click(reply as HTMLElement);
    });
    expect(uploads[0]?.signal?.aborted).toBe(true);
    expect(within(threadPanel()).queryByTitle('shot.png')).toBeNull();
  });
});

describe('ThreadPanel 첨부 props', () => {
  const root = { id: 'm1', conversationId: 'c1', author: '홍길동', createdAt: T0, body: '원문', replyCount: 0 };

  it('(c) 전송 시 onSend 세 번째 인자로 attachmentIds', async () => {
    const onSend = vi.fn();
    const done = attachment({ mime: 'image/png' });
    const { createAttachmentDraftStore } = await import('../../src/features/conversation/attachments/attachment-drafts.js');
    render(
      <ThreadPanel
        variant="wide"
        root={root}
        replies={[]}
        onClose={() => undefined}
        onSend={onSend}
        announce={() => undefined}
        onUpload={async () => ({ ok: true, value: done })}
        attachmentDrafts={createAttachmentDraftStore()}
      />,
    );
    const box = screen.getByRole('textbox', { name: COMPOSER_COPY.replyLabel });
    await paste(box, [png()]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '전송' }));
    });
    expect(onSend).toHaveBeenCalledWith(expect.any(String), undefined, [done.id]);
  });

  it('비활성 상대 DM(composerNotice)이면 작성기 대신 안내 — 첨부 버튼 없음', () => {
    render(
      <ThreadPanel
        variant="wide"
        root={root}
        replies={[]}
        onClose={() => undefined}
        onSend={() => undefined}
        announce={() => undefined}
        onUpload={async () => ({ ok: false, status: 'network' })}
        composerNotice={COMPOSER_COPY.inactivePeer}
      />,
    );
    expect(screen.queryByRole('button', { name: ATTACHMENT_COPY.attach })).toBeNull();
    expect(screen.getByText(COMPOSER_COPY.inactivePeer)).toBeTruthy();
  });

  it('첨부가 있는 답글은 MessageItem 첨부 목록으로 그린다', () => {
    const reply = { id: 'r9', conversationId: 'c1', rootId: 'm1', author: '김철수', createdAt: T0, body: '사진', replyCount: 0, attachments: [attachment({ mime: 'image/png' })] };
    render(<ThreadPanel variant="wide" root={root} replies={[reply]} onClose={() => undefined} onSend={() => undefined} announce={() => undefined} />);
    const list = document.querySelector('.thread-replies');
    expect(list?.querySelector('.attachment-list .attachment-item')).not.toBeNull();
  });
});
