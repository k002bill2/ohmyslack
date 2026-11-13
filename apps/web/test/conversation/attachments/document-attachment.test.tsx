/**
 * W-28 문서 첨부 웹(FR-OPS-09 보조, UI_STATES §2-13, COPY_GAPS G-53–G-62) — UI-AC-01–08·10·11.
 * 텍스트 계열 3종(TRD §6-1-1 R3.6)·415 하위 코드(TRD §3) 포함. UI-AC-09(폭 3종 넘침)는 실브라우저 확인 항목.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_415_CODES,
  ATTACHMENT_DOC_MAX_BYTES,
  ATTACHMENT_FILENAME_HEADER,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TEXT_MIMES,
  type AttachmentView,
} from '../../../../../packages/shared/src/index.js';
import type { ActionResult } from '../../../src/data/index.js';
import { CONV, setup } from '../../sync/fake-server.js';
import { Composer } from '../../../src/features/conversation';
import { AttachmentList } from '../../../src/features/conversation/attachments/index.js';
import { uploadErrorText } from '../../../src/features/conversation/attachments/composer-upload.js';
import { ATTACHMENT_COPY, DOCUMENT_KIND_COPY, ERROR_COPY } from '../../../src/ui/copy.js';
import { attachment } from './fixtures.js';

afterEach(cleanup);

type Result = ActionResult<AttachmentView>;
type Upload = (f: File, o?: { readonly filename?: string; readonly type?: string; readonly signal?: AbortSignal }) => Promise<Result>;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSM = 'application/vnd.ms-excel.sheet.macroEnabled.12';

function file(name: string, size = 2048, type = ''): File {
  const f = new File([new Uint8Array(4)], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

function deferred() {
  let resolve!: (r: Result) => void;
  const promise = new Promise<Result>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function mount(upload: Upload) {
  const onSend = vi.fn();
  const { container } = render(<Composer label="메시지" onSend={onSend} onUpload={upload} />);
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const pick = async (...files: File[]) => {
    await act(async () => {
      fireEvent.change(input, { target: { files } });
    });
  };
  const sendBtn = () => screen.getByRole('button', { name: '전송' }) as HTMLButtonElement;
  return { onSend, input, pick, sendBtn };
}

describe('FR-OPS-09 작성기 문서 칩', () => {
  it('UI-AC-01 첨부 버튼 이름 「파일 첨부」, accept = G-54 목록(텍스트 3종 포함)', () => {
    const { input } = mount(vi.fn());
    expect(screen.getByRole('button', { name: ATTACHMENT_COPY.attach })).toBeTruthy();
    expect(ATTACHMENT_COPY.attach).toBe('파일 첨부');
    // COPY_GAPS G-54 accept 목록(인용).
    const g54 = '.png,.jpg,.jpeg,.webp,.pdf,.docx,.docm,.xlsx,.xlsm,.pptx,.pptm,.doc,.xls,.ppt,.hwp,.hwpx,.txt,.md,.csv';
    expect(input.getAttribute('accept')?.split(',').sort()).toEqual(g54.split(',').sort());
    expect(input.multiple).toBe(true);
  });

  it('G-54 문구에 텍스트 계열 TXT·MD·CSV가 들어 있다', () => {
    for (const label of [DOCUMENT_KIND_COPY.txt, DOCUMENT_KIND_COPY.md, DOCUMENT_KIND_COPY.csv]) expect(ATTACHMENT_COPY.unsupported).toContain(label);
  });

  it.each([
    ['허용 밖 확장자', file('run.exe'), ATTACHMENT_COPY.unsupported],
    ['문서 상한+1', file('big.pdf', ATTACHMENT_DOC_MAX_BYTES + 1), ATTACHMENT_COPY.docTooLarge],
    ['텍스트 상한+1', file('big.csv', ATTACHMENT_DOC_MAX_BYTES + 1), ATTACHMENT_COPY.docTooLarge],
    ['이미지 상한+1', file('big.png', ATTACHMENT_MAX_BYTES + 1, 'image/png'), ATTACHMENT_COPY.tooLarge],
  ])('UI-AC-02 %s → 요청 없이 칩 실패 + role=alert 1회, 다시 시도 없음', async (_n, f, text) => {
    const upload = vi.fn<Upload>();
    const { pick } = mount(upload);
    await pick(f);
    expect(upload).not.toHaveBeenCalled();
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain(text);
    expect(screen.queryByRole('button', { name: ATTACHMENT_COPY.retry })).toBeNull();
  });

  it('문서 상한 이하(이미지 상한 초과)는 사전 거부하지 않는다', async () => {
    const upload = vi.fn<Upload>(async () => ({ ok: true, value: attachment({ mime: 'application/pdf', filename: 'a.pdf' }) }));
    const { pick } = mount(upload);
    await pick(file('a.pdf', ATTACHMENT_MAX_BYTES + 1));
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it.each(ATTACHMENT_TEXT_MIMES.map((m, i) => [m, ['note.txt', 'readme.md', 'table.csv'][i] as string]))(
    '텍스트 계열 %s(%s)는 파일명·octet-stream으로 업로드하고 칩 표지가 확장자 대문자',
    async (_mime, name) => {
      const upload = vi.fn<Upload>(() => new Promise<Result>(() => undefined));
      const { pick } = mount(upload);
      await pick(file(name, 100, 'text/plain'));
      expect(upload).toHaveBeenCalledTimes(1);
      const opts = upload.mock.calls[0]?.[1];
      expect(opts?.filename).toBe(name);
      expect(opts?.type).toBe('application/octet-stream');
      expect(opts?.signal).toBeInstanceOf(AbortSignal);
      const chip = screen.getByText(name).closest('li') as HTMLElement;
      expect(within(chip).getByText(name.split('.')[1]?.toUpperCase() ?? '')).toBeTruthy();
    },
  );

  it('이미지는 파일명 헤더 없이 파일 형식으로 업로드', async () => {
    const upload = vi.fn<Upload>(() => new Promise<Result>(() => undefined));
    const { pick } = mount(upload);
    await pick(file('a.png', 100, 'image/png'));
    expect(upload.mock.calls[0]?.[1]?.filename).toBeUndefined();
    expect(upload.mock.calls[0]?.[1]?.type).toBeUndefined();
  });

  it.each<[number, string | undefined, string]>([
    [413, undefined, ATTACHMENT_COPY.docTooLarge],
    [415, undefined, ATTACHMENT_COPY.unsupported],
    ...ATTACHMENT_415_CODES.map((code) => [415, code, code === 'macro_extension_mismatch' ? ATTACHMENT_COPY.macroExtension : ATTACHMENT_COPY.unsupported] as [number, string, string]),
    [415, 'unknown_future_code', ATTACHMENT_COPY.unsupported],
  ])('UI-AC-03 서버 %s(code %s) → 전용 문구, 다시 시도 없음', async (status, code, text) => {
    const upload = vi.fn<Upload>(async () => (code === undefined ? { ok: false, status } : { ok: false, status, code }) as Result);
    const { pick } = mount(upload);
    await pick(file('report.docx'));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(text);
    expect(screen.queryByRole('button', { name: ATTACHMENT_COPY.retry })).toBeNull();
  });

  it.each([
    [500, ERROR_COPY.server],
    ['network' as const, ERROR_COPY.network],
  ])('UI-AC-03 %s → 「업로드하지 못했습니다.」 + 원인 + 다시 시도(같은 파일 재업로드)', async (status, cause) => {
    const upload = vi.fn<Upload>(async () => ({ ok: false, status }) as Result);
    const { pick } = mount(upload);
    await pick(file('report.pdf'));
    expect(screen.getByRole('alert').textContent).toContain(`${ATTACHMENT_COPY.uploadFailed} ${cause}`);
    upload.mockResolvedValueOnce({ ok: true, value: attachment({ mime: 'application/pdf', filename: 'report.pdf' }) });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ATTACHMENT_COPY.retry }));
    });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('413 이미지 칩은 이미지 상한 문구', () => {
    expect(uploadErrorText({ status: 413 }, 'image')).toBe(ATTACHMENT_COPY.tooLarge);
    expect(uploadErrorText({ status: 413 })).toBe(ATTACHMENT_COPY.docTooLarge);
  });

  it('UI-AC-04 업로드 중: 「업로드 중」·aria-busy·전송 비활성, 「첨부 제거」가 요청을 abort하고 포커스는 입력란', async () => {
    const d = deferred();
    const upload = vi.fn<Upload>(() => d.promise);
    const { pick, sendBtn } = mount(upload);
    await pick(file('plan.hwp'));
    const chip = screen.getByText('plan.hwp').closest('li') as HTMLElement;
    expect(chip.getAttribute('aria-busy')).toBe('true');
    expect(within(chip).getByText(ATTACHMENT_COPY.uploading)).toBeTruthy();
    expect(within(chip).getByText(DOCUMENT_KIND_COPY.hwp)).toBeTruthy();
    expect(sendBtn().disabled).toBe(true);
    const signal = upload.mock.calls[0]?.[1]?.signal;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `${ATTACHMENT_COPY.remove}: plan.hwp` }));
    });
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText('plan.hwp')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '메시지' }));
    // 늦은 응답은 버린다.
    await act(async () => d.resolve({ ok: true, value: attachment({ mime: 'application/x-hwp', filename: 'plan.hwp' }) }));
    expect(screen.queryByText('plan.hwp')).toBeNull();
  });

  it('제거 뒤 포커스: 다음 칩의 「첨부 제거」', async () => {
    const upload = vi.fn<Upload>(() => new Promise<Result>(() => undefined));
    const { pick } = mount(upload);
    await pick(file('a.pdf'), file('b.pdf'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `${ATTACHMENT_COPY.remove}: a.pdf` }));
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `${ATTACHMENT_COPY.remove}: b.pdf` }));
  });

  it('UI-AC-05 업로드는 20초 상한에 걸리지 않고, 문서는 퍼센트 인코딩 파일명 헤더·octet-stream으로 보낸다', async () => {
    vi.useFakeTimers();
    try {
      const { server } = setup();
      let seen: RequestInit | undefined;
      const fetch = (url: string, init?: RequestInit): Promise<Response> => {
        if (url.startsWith('/api/attachments')) {
          seen = init;
          return new Promise<Response>(() => undefined);
        }
        return server.fetch(url, init);
      };
      const { ds } = setup({ fetch });
      let settled = false;
      const name = '보고서 v2.pdf';
      void ds.uploadAttachment?.(CONV, file(name), { filename: name, type: 'application/octet-stream' }).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(settled).toBe(false);
      const headers = seen?.headers as Record<string, string>;
      expect(headers[ATTACHMENT_FILENAME_HEADER]).toBe(encodeURIComponent(name));
      expect(headers['Content-Type']).toBe('application/octet-stream');
    } finally {
      vi.useRealTimers();
    }
  });

  it('데이터 계층은 415 하위 코드를 그대로 돌려준다', async () => {
    const { server, ds } = setup();
    for (const code of ATTACHMENT_415_CODES) {
      server.on('POST /api/attachments', () => ({ status: 415, body: { error: { code, request_id: 'r' } } }));
      const r = await ds.uploadAttachment?.(CONV, file('a.docx'), { filename: 'a.docx', type: 'application/octet-stream' });
      expect(r).toEqual({ ok: false, status: 415, code });
    }
  });

  it('UI-AC-06 문서만 보낼 때 본문은 「[문서]」, 이미지가 먼저면 「[이미지]」', async () => {
    const upload = vi.fn<Upload>(async (f) => ({ ok: true, value: attachment({ mime: f.name.endsWith('.png') ? 'image/png' : 'application/pdf' }) }));
    const first = mount(upload);
    await first.pick(file('a.pdf'));
    await act(async () => {
      fireEvent.click(first.sendBtn());
    });
    expect(first.onSend.mock.calls[0]?.[0]).toBe(ATTACHMENT_COPY.documentOnlyBody);
    cleanup();
    const second = mount(upload);
    await second.pick(file('a.png', 100, 'image/png'), file('b.pdf'));
    await act(async () => {
      fireEvent.click(second.sendBtn());
    });
    expect(second.onSend.mock.calls[0]?.[0]).toBe(ATTACHMENT_COPY.imageOnlyBody);
  });
});

describe('FR-OPS-09 메시지 안 문서 행', () => {
  const doc = (over: Partial<AttachmentView> = {}) => attachment({ mime: DOCX, byte_size: 2.4 * 1024 * 1024, filename: '분기 보고서.docx', has_macros: false, ...over });

  it('UI-AC-07 형식 표지·파일명·크기·「받기」, 접근 이름 「{파일명} 받기, {형식}, {크기}」', () => {
    render(<AttachmentList attachments={[doc()]} />);
    const item = screen.getByRole('listitem');
    expect(within(item).getByText(DOCUMENT_KIND_COPY.word)).toBeTruthy();
    expect(within(item).getByText('2.4MB')).toBeTruthy();
    const link = within(item).getByRole('link', { name: '분기 보고서.docx 받기, Word, 2.4MB' });
    expect(link.textContent).toContain(ATTACHMENT_COPY.download);
    expect(within(item).getByTitle('분기 보고서.docx')).toBeTruthy();
    // 키보드: 행 안 탭 정류장은 「받기」 하나.
    expect(item.querySelectorAll('a[href], button, [tabindex]')).toHaveLength(1);
    link.focus();
    expect(document.activeElement).toBe(link);
  });

  it.each([
    ['text/plain', 'a.txt', DOCUMENT_KIND_COPY.txt],
    ['text/markdown', 'a.md', DOCUMENT_KIND_COPY.md],
    ['text/csv', 'a.csv', DOCUMENT_KIND_COPY.csv],
    ['application/pdf', 'a.pdf', DOCUMENT_KIND_COPY.pdf],
    ['application/hwp+zip', 'a.hwpx', DOCUMENT_KIND_COPY.hwp],
    ['application/vnd.ms-powerpoint', 'a.ppt', DOCUMENT_KIND_COPY.powerpoint],
  ] as const)('형식 표지: %s → %s', (mime, filename, label) => {
    render(<AttachmentList attachments={[doc({ mime, filename })]} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText(ATTACHMENT_COPY.macros)).toBeNull();
  });

  it('UI-AC-08 has_macros → 「매크로 포함」 텍스트 + 접근 이름 끝 「, 매크로 포함」', () => {
    render(<AttachmentList attachments={[doc({ mime: XLSM, filename: '예산.xlsm', byte_size: 1.2 * 1024 * 1024, has_macros: true })]} />);
    expect(screen.getByText(ATTACHMENT_COPY.macros)).toBeTruthy();
    expect(screen.getByRole('link', { name: '예산.xlsm 받기, Excel, 1.2MB, 매크로 포함' })).toBeTruthy();
  });

  it('긴 파일명: 확장자부를 별도 요소로 둬 말줄임에서 빠진다', () => {
    const { container } = render(<AttachmentList attachments={[doc({ filename: `${'가'.repeat(150)}.docm`, mime: 'application/vnd.ms-word.document.macroEnabled.12' })]} />);
    expect(container.querySelector('.doc-name-ext')?.textContent).toBe('.docm');
    expect(container.querySelector('.doc-name-stem')?.textContent).toBe('가'.repeat(150));
  });

  it('UI-AC-10 expired → 「만료된 첨부입니다」, 받기·크기 없음, 탭 정류장 없음', () => {
    const { container } = render(<AttachmentList attachments={[doc({ expired: true })]} />);
    expect(screen.getByText(ATTACHMENT_COPY.expired)).toBeTruthy();
    expect(screen.getByText(DOCUMENT_KIND_COPY.word)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('2.4MB')).toBeNull();
    expect(container.querySelectorAll('a[href], button, [tabindex]')).toHaveLength(0);
  });

  it('UI-AC-11 「받기」는 /api/attachments/{id} download 링크(JS fetch 없음), 봇·사람 행 DOM 동일', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const a = doc();
    const { container: one } = render(<AttachmentList attachments={[a]} />);
    const link = one.querySelector('a.doc-download') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/api/attachments/${a.id}`);
    expect(link.hasAttribute('download')).toBe(true);
    fireEvent.click(link);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    // 같은 projection이면 작성자(봇·사람)와 무관하게 같은 DOM — 행은 작성자 정보를 받지 않는다.
    const { container: two } = render(<AttachmentList attachments={[a]} />);
    expect(two.innerHTML).toBe(one.innerHTML);
  });
});
