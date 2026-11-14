/**
 * 폭 구간 전환(작성기 재마운트)에도 첨부 칩·진행 중 업로드가 유지되는지(QA r2 관찰 3).
 * 칩·업로드 손잡이는 AppShell이 소유한 메모리 전용 첨부 초안 저장소에 있다(B7 — 지속 저장 없음).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentView } from '../../../../../packages/shared/src/index.js';
import { App } from '../../../src/App.js';
import type { ActionResult, UploadAttachmentOptions } from '../../../src/data/index.js';
import { memory } from '../../helpers/fixtures.js';
import { installViewport, resizeTo } from '../../helpers/viewport.js';
import { attachment } from './fixtures.js';

afterEach(cleanup);

type Result = ActionResult<AttachmentView>;

interface Call {
  readonly conversationId: string;
  readonly name: string;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (r: Result) => void;
  readonly reject: (e: unknown) => void;
}

function setup(width = 834) {
  installViewport(width);
  const calls: Call[] = [];
  const ds = memory();
  const send = vi.fn();
  const source = Object.assign(Object.create(Object.getPrototypeOf(ds)), ds, {
    send,
    uploadAttachment: (conversationId: string, file: File, options?: UploadAttachmentOptions) =>
      new Promise<Result>((resolve, reject) => {
        calls.push({ conversationId, name: file.name, signal: options?.signal, resolve, reject });
      }),
  });
  const view = render(<App dataSource={source} />);
  const user = userEvent.setup();
  const open = (name: string | RegExp) => user.click(screen.getByRole('button', { name }));
  const box = () => screen.getByRole('textbox', { name: '#general에 메시지 작성' }) as HTMLTextAreaElement;
  const pick = async (...files: File[]) => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files } });
    });
  };
  const chips = () => Array.from(document.querySelectorAll('.composer-chip'));
  const resize = async (w: number) => {
    await act(async () => {
      resizeTo(w);
    });
  };
  const sendBtn = () => screen.getByRole('button', { name: '전송' }) as HTMLButtonElement;
  return { calls, send, view, user, open, box, pick, chips, resize, sendBtn };
}

const pdf = (name = 'a.pdf') => new File(['x'], name);

describe('첨부 초안 저장소 — 폭 구간 전환', () => {
  it('834 → 390 → 1280: 칩·글 초안·완료 첨부 ID 유지 → 전송 시 결속', async () => {
    const t = setup(834);
    await t.open('general');
    await t.user.type(t.box(), '초안');
    await t.pick(pdf());
    const a = attachment({ mime: 'application/pdf' });
    await act(async () => t.calls[0]?.resolve({ ok: true, value: a }));
    const before = t.box();

    await t.resize(390);
    expect(t.box()).not.toBe(before); // 작성기가 다시 마운트됐다(재현 조건)
    expect(t.box().value).toBe('초안');
    expect(screen.getByTitle('a.pdf')).toBeTruthy();

    await t.resize(1280);
    expect(t.box().value).toBe('초안');
    expect(t.chips()).toHaveLength(1);
    expect(t.sendBtn().disabled).toBe(false);
    fireEvent.click(t.sendBtn());
    expect(t.send).toHaveBeenCalledWith({ conversationId: 'c1' }, '초안', undefined, [a.id]);
    expect(t.chips()).toHaveLength(0);
    expect(t.calls).toHaveLength(1); // 다시 올리지 않는다
  });

  it('업로드 중 전환: 전환 뒤 완료되면 새 작성기 칩이 완료로 바뀐다(요청은 끊기지 않음)', async () => {
    const t = setup(834);
    await t.open('general');
    await t.pick(pdf());
    await t.resize(390);
    expect(t.chips()).toHaveLength(1);
    expect(t.sendBtn().disabled).toBe(true);
    expect(t.calls[0]?.signal?.aborted).toBe(false);
    const a = attachment({ mime: 'application/pdf' });
    await act(async () => t.calls[0]?.resolve({ ok: true, value: a }));
    expect(t.sendBtn().disabled).toBe(false);
    fireEvent.click(t.sendBtn());
    expect(t.send).toHaveBeenCalledWith({ conversationId: 'c1' }, expect.any(String), undefined, [a.id]);
  });

  it('업로드 중 전환: 전환 뒤 실패하면 새 작성기 칩이 실패 칩(「다시 시도」)이 된다', async () => {
    const t = setup(834);
    await t.open('general');
    await t.pick(pdf());
    await t.resize(390);
    await act(async () => t.calls[0]?.reject(new Error('network')));
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy();
    expect(t.sendBtn().disabled).toBe(true);
  });

  it('동시 2건 상한 대기열도 전환 뒤 이어진다: 첫 업로드가 끝나면 세 번째가 시작된다', async () => {
    const t = setup(834);
    await t.open('general');
    await t.pick(pdf('1.pdf'), pdf('2.pdf'), pdf('3.pdf'));
    expect(t.calls.map((c) => c.name)).toEqual(['1.pdf', '2.pdf']);
    await t.resize(390);
    await act(async () => t.calls[0]?.resolve({ ok: true, value: attachment({ mime: 'application/pdf' }) }));
    expect(t.calls.map((c) => c.name)).toEqual(['1.pdf', '2.pdf', '3.pdf']);
    expect(t.chips()).toHaveLength(3);
  });
});

describe('첨부 초안 저장소 — 수명', () => {
  it('셸 언마운트(로그아웃·401 경로): 진행 중 업로드 abort, 다시 그린 셸에 이전 칩 없음', async () => {
    const t = setup(834);
    await t.open('general');
    await t.pick(pdf());
    const signal = t.calls[0]?.signal;
    expect(signal?.aborted).toBe(false);
    t.view.unmount();
    expect(signal?.aborted).toBe(true);
    // 늦게 온 응답은 아무 데도 반영되지 않는다(언마운트된 작성기에 setState 없음).
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () => t.calls[0]?.resolve({ ok: true, value: attachment() }));
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();

    const again = setup(834);
    await again.open('general');
    expect(again.chips()).toHaveLength(0);
  });

  it('대화 A의 칩은 대화 B 작성기에 없고, A로 돌아와도 없다(전환 시 폐기 + abort)', async () => {
    const t = setup(1280);
    await t.open('general');
    await t.pick(pdf());
    const signal = t.calls[0]?.signal;
    await t.open(/^dev/);
    expect(t.chips()).toHaveLength(0);
    expect(signal?.aborted).toBe(true);
    await t.open('general');
    expect(t.chips()).toHaveLength(0);
  });

  it('칩 제거는 지금처럼 요청을 끊고 칩을 없앤다(전환 뒤에도)', async () => {
    const t = setup(834);
    await t.open('general');
    await t.pick(pdf());
    await t.resize(390);
    await t.user.click(screen.getByRole('button', { name: '첨부 제거: a.pdf' }));
    expect(t.calls[0]?.signal?.aborted).toBe(true);
    expect(t.chips()).toHaveLength(0);
    await t.resize(1280);
    expect(t.chips()).toHaveLength(0);
  });
});
