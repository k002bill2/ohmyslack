/** W-22 Composer 이미지 첨부(Jarvis ★ 임시 결정 Q-H3): 업로드 성공·413·415·기타 실패·제거·본문 자리 문구·업로드 중 전송 비활성. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentView } from '../../../../../packages/shared/src/index.js';
import type { ActionResult } from '../../../src/data/index.js';
import { Composer } from '../../../src/features/conversation';
import { ATTACHMENT_COPY } from '../../../src/ui/copy.js';
import { attachment } from './fixtures.js';

afterEach(cleanup);

type Result = ActionResult<AttachmentView>;

function deferred() {
  let resolve!: (r: Result) => void;
  const promise = new Promise<Result>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function png(name = 'a.png', size = 2048, type = 'image/png'): File {
  const f = new File([new Uint8Array(4)], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

function mount(upload: (f: File) => Promise<Result>) {
  const onSend = vi.fn();
  const { container } = render(<Composer label="메시지" onSend={onSend} onUpload={upload} />);
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const pick = async (...files: File[]) => {
    await act(async () => {
      fireEvent.change(input, { target: { files } });
    });
  };
  const sendBtn = () => screen.getByRole('button', { name: '전송' }) as HTMLButtonElement;
  const type = (v: string) => fireEvent.change(screen.getByRole('textbox', { name: '메시지' }), { target: { value: v } });
  return { onSend, input, pick, sendBtn, type };
}

describe('Composer 이미지 첨부', () => {
  it('파일 선택은 이미지 3종만(accept), 업로드 함수가 없으면 첨부 UI 없음', () => {
    const { input } = mount(vi.fn());
    expect(input.getAttribute('accept')?.split(',').sort()).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    cleanup();
    render(<Composer label="메시지" onSend={vi.fn()} />);
    expect(screen.queryByRole('button', { name: ATTACHMENT_COPY.attach })).toBeNull();
  });

  it('업로드 중: 칩(파일명·크기) + 전송 비활성·aria-busy → 완료 후 attachment_ids와 함께 전송, 칩 비움', async () => {
    const d = deferred();
    const { pick, sendBtn, type, onSend } = mount(() => d.promise);
    type('사진');
    await pick(png('cat.png', 2048));
    expect(screen.getByText('cat.png')).toBeTruthy();
    expect(screen.getByText('2KB')).toBeTruthy();
    expect(sendBtn().disabled).toBe(true);
    expect(sendBtn().getAttribute('aria-busy')).toBe('true');
    const a = attachment({ mime: 'image/png' });
    await act(async () => d.resolve({ ok: true, value: a }));
    expect(sendBtn().disabled).toBe(false);
    expect(sendBtn().hasAttribute('aria-busy')).toBe(false);
    fireEvent.click(sendBtn());
    expect(onSend).toHaveBeenCalledWith('사진', undefined, [a.id]);
    expect(screen.queryByText('cat.png')).toBeNull();
  });

  it('본문이 비면 자리 문구 「[이미지]」를 본문으로 보낸다', async () => {
    const a = attachment({ mime: 'image/png' });
    const { pick, sendBtn, onSend } = mount(async () => ({ ok: true, value: a }));
    expect(sendBtn().disabled).toBe(true);
    await pick(png());
    fireEvent.click(sendBtn());
    expect(onSend).toHaveBeenCalledWith(ATTACHMENT_COPY.imageOnlyBody, undefined, [a.id]);
  });

  it.each([
    [413, ATTACHMENT_COPY.tooLarge],
    [415, ATTACHMENT_COPY.unsupported],
  ])('실패 %s → role=alert 「%s」, 다시 시도 없음(같은 파일은 결과가 같다) · 제거하면 전송 가능', async (status, text) => {
    const { pick, sendBtn, type } = mount(async (): Promise<Result> => ({ ok: false, status }));
    type('본문');
    await pick(png('p.png'));
    expect(screen.getByRole('alert').textContent).toContain(text);
    expect(screen.queryByRole('button', { name: ATTACHMENT_COPY.retry })).toBeNull();
    expect(sendBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: `${ATTACHMENT_COPY.remove}: p.png` }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sendBtn().disabled).toBe(false);
  });

  it.each([
    [500, ATTACHMENT_COPY.uploadFailed],
    ['network' as const, ATTACHMENT_COPY.uploadFailed],
  ])('실패 %s → role=alert 1개 「%s」 + 다시 시도, 실패 칩이 있으면 전송 비활성', async (status, text) => {
    const upload = vi.fn(async (): Promise<Result> => ({ ok: false, status } as Result));
    const { pick, sendBtn, type } = mount(upload);
    type('본문');
    await pick(png());
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain(text);
    expect(sendBtn().disabled).toBe(true);
    const a = attachment({ mime: 'image/png' });
    upload.mockResolvedValueOnce({ ok: true, value: a });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ATTACHMENT_COPY.retry }));
    });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sendBtn().disabled).toBe(false);
  });

  it('업로드 전 판정: 상한 초과·이미지 아닌 형식은 업로드를 부르지 않고 같은 문구', async () => {
    const upload = vi.fn();
    const { pick } = mount(upload);
    await pick(png('big.png', 10 * 1024 * 1024 + 1));
    expect(screen.getByRole('alert').textContent).toContain(ATTACHMENT_COPY.tooLarge);
    cleanup();
    const second = mount(upload);
    await second.pick(png('a.mp3', 100, 'audio/mpeg'));
    expect(screen.getByRole('alert').textContent).toContain(ATTACHMENT_COPY.unsupported);
    expect(upload).not.toHaveBeenCalled();
  });

  it('제거: 칩이 사라지고 늦게 끝난 업로드는 무시, 그 ID는 보내지 않는다', async () => {
    const d = deferred();
    const { pick, sendBtn, type, onSend } = mount(() => d.promise);
    type('본문');
    await pick(png('x.png'));
    fireEvent.click(screen.getByRole('button', { name: `${ATTACHMENT_COPY.remove}: x.png` }));
    expect(screen.queryByText('x.png')).toBeNull();
    await act(async () => d.resolve({ ok: true, value: attachment({ mime: 'image/png' }) }));
    expect(screen.queryByText('x.png')).toBeNull();
    fireEvent.click(sendBtn());
    expect(onSend).toHaveBeenCalledWith('본문');
  });

  it('메시지당 상한(4)을 넘는 파일은 칩을 만들지 않고 첨부 버튼을 비활성', async () => {
    const upload = vi.fn(async (): Promise<Result> => ({ ok: true, value: attachment({ mime: 'image/png' }) }));
    const { pick } = mount(upload);
    await pick(png('1.png'), png('2.png'), png('3.png'), png('4.png'), png('5.png'));
    expect(upload).toHaveBeenCalledTimes(4);
    expect(screen.queryByText('5.png')).toBeNull();
    expect((screen.getByRole('button', { name: ATTACHMENT_COPY.attach }) as HTMLButtonElement).disabled).toBe(true);
  });
});
