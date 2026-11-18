/** 작성기 클립보드 붙여넣기 첨부: 순수 판정 함수 + Composer onPaste 연결(브리프 composer-paste 규칙 1~7). */
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentView } from '../../../../../packages/shared/src/index.js';
import type { ActionResult } from '../../../src/data/index.js';
import { Composer } from '../../../src/features/conversation';
import { pastedFiles } from '../../../src/features/conversation/attachments/clipboard-files.js';
import { ATTACHMENT_COPY } from '../../../src/ui/copy.js';
import { attachment } from './fixtures.js';

afterEach(cleanup);

type Result = ActionResult<AttachmentView>;

function file(name: string, type: string, size = 2048): File {
  const f = new File([new Uint8Array(4)], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

interface ClipOpts {
  readonly files?: readonly File[];
  readonly items?: readonly File[];
  readonly text?: string;
  readonly html?: string;
}

/** jsdom에는 DataTransfer가 없어 클립보드 모양만 흉내 낸다. */
function clip({ files = [], items = [], text = '', html = '' }: ClipOpts) {
  return {
    files: [...files],
    items: [
      ...items.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
      { kind: 'file', type: 'image/png', getAsFile: () => null },
      ...(text === '' ? [] : [{ kind: 'string', type: 'text/plain', getAsFile: () => null }]),
    ],
    getData: (format: string) => (format === 'text/plain' ? text : format === 'text/html' ? html : ''),
  };
}

describe('pastedFiles', () => {
  it('파일이 없으면 null(기본 텍스트 붙여넣기)', () => {
    expect(pastedFiles(clip({ text: '안녕' }))).toBeNull();
    expect(pastedFiles(null)).toBeNull();
  });

  it('files 우선, 비면 items의 kind=file → getAsFile(null 제외)', () => {
    const a = file('a.png', 'image/png');
    const b = file('b.png', 'image/png');
    expect(pastedFiles({ ...clip({ items: [b] }), files: [a] })).toEqual([a]);
    expect(pastedFiles(clip({ items: [b] }))).toEqual([b]);
  });

  it('파일 + 비어 있지 않은 text/plain → null(텍스트 우선)', () => {
    expect(pastedFiles(clip({ files: [file('t.png', 'image/png')], text: 'A\tB' }))).toBeNull();
  });

  it('파일 + 파일명과 같은 text/plain(Finder 복사) → 첨부', () => {
    const a = file('report.pdf', 'application/pdf');
    expect(pastedFiles(clip({ files: [a], text: 'report.pdf' }))).toEqual([a]);
    const b = file('a.png', 'image/png');
    const c = file('b.png', 'image/png');
    expect(pastedFiles(clip({ files: [b, c], text: 'a.png\r\nb.png\n' }))).toEqual([b, c]);
  });

  it('파일 + 공백뿐인 text/plain → 첨부', () => {
    const a = file('t.png', 'image/png');
    expect(pastedFiles(clip({ files: [a], text: '  \n' }))).toEqual([a]);
  });

  it('파일 + 파일명과 다른 text/plain → null 유지', () => {
    expect(pastedFiles(clip({ files: [file('report.pdf', 'application/pdf')], text: 'other.pdf' }))).toBeNull();
    expect(pastedFiles(clip({ files: [file('a.png', 'image/png')], text: 'a.png\nextra' }))).toBeNull();
  });

  it('파일 + text/html만 → 첨부', () => {
    const a = file('a.png', 'image/png');
    expect(pastedFiles(clip({ files: [a], html: '<b>표</b>' }))).toEqual([a]);
  });

  it('이름이 없거나 확장자가 허용 밖인 허용 이미지 MIME은 image.<ext>로 이름만 바꾼다', () => {
    const [p] = pastedFiles(clip({ files: [file('', 'image/png')] })) ?? [];
    expect(p?.name).toBe('image.png');
    expect(p?.type).toBe('image/png');
    const [j] = pastedFiles(clip({ files: [file('clip', 'image/jpeg')] })) ?? [];
    expect(j?.name).toBe('image.jpg');
    const [w] = pastedFiles(clip({ files: [file('x.tmp', 'image/webp')] })) ?? [];
    expect(w?.name).toBe('image.webp');
  });

  it('그 외 파일은 이름을 바꾸지 않는다', () => {
    const ok = file('cat.png', 'image/png');
    const gif = file('', 'image/gif');
    const zip = file('a.zip', 'application/zip');
    expect(pastedFiles(clip({ files: [ok, gif, zip] }))).toEqual([ok, gif, zip]);
  });
});

function mount(upload?: (f: File) => Promise<Result>) {
  const onSend = vi.fn();
  render(<Composer label="메시지" onSend={onSend} {...(upload === undefined ? {} : { onUpload: upload })} />);
  const box = () => screen.getByRole('textbox', { name: '메시지' });
  /** 붙여넣기 → 기본 동작이 막혔으면 true. */
  const paste = async (data: ReturnType<typeof clip>): Promise<boolean> => {
    const ev = createEvent.paste(box(), { clipboardData: data });
    await act(async () => {
      fireEvent(box(), ev);
    });
    return ev.defaultPrevented;
  };
  return { onSend, paste };
}

describe('Composer 붙여넣기 첨부', () => {
  it('텍스트만 → 기본 동작, 첨부 0', async () => {
    const upload = vi.fn();
    const { paste } = mount(upload);
    expect(await paste(clip({ text: '안녕' }))).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });

  it('이미지 1개 → preventDefault, 칩 1·업로드 호출', async () => {
    const a = attachment({ mime: 'image/png' });
    const upload = vi.fn(async () => ({ ok: true, value: a }) as Result);
    const { paste } = mount(upload);
    expect(await paste(clip({ files: [file('cat.png', 'image/png')] }))).toBe(true);
    expect(screen.getByTitle('cat.png')).toBeTruthy();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('파일 + text/plain → 첨부 0, 기본 동작', async () => {
    const upload = vi.fn();
    const { paste } = mount(upload);
    expect(await paste(clip({ files: [file('t.png', 'image/png')], text: '표' }))).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });

  it('이름 없는 image/png → image.png 칩으로 업로드', async () => {
    const upload = vi.fn(async () => ({ ok: true, value: attachment({ mime: 'image/png' }) }) as Result);
    const { paste } = mount(upload);
    await paste(clip({ items: [file('', 'image/png')] }));
    expect(screen.getByTitle('image.png')).toBeTruthy();
    expect((upload.mock.calls[0] as unknown as [File])[0].name).toBe('image.png');
  });

  it('허용 밖 형식 → 기존 G-54 실패 칩, 업로드 안 함', async () => {
    const upload = vi.fn();
    const { paste } = mount(upload);
    expect(await paste(clip({ files: [file('a.zip', 'application/zip')] }))).toBe(true);
    expect(screen.getByText(ATTACHMENT_COPY.unsupported)).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
  });

  it('onUpload 없음 → 가로채지 않는다', async () => {
    const { paste } = mount();
    expect(await paste(clip({ files: [file('cat.png', 'image/png')] }))).toBe(false);
    expect(screen.queryByTitle('cat.png')).toBeNull();
  });

  it('칩이 가득 차면(full) preventDefault만, 추가 0', async () => {
    const upload = vi.fn(() => new Promise<Result>(() => {}));
    const { paste } = mount(upload);
    const many = Array.from({ length: 20 }, (_, i) => file(`f${i}.png`, 'image/png'));
    await paste(clip({ files: many }));
    const before = upload.mock.calls.length + document.querySelectorAll('[title$=".png"]').length;
    expect(await paste(clip({ files: [file('extra.png', 'image/png')] }))).toBe(true);
    expect(screen.queryByTitle('extra.png')).toBeNull();
    expect(upload.mock.calls.length + document.querySelectorAll('[title$=".png"]').length).toBe(before);
  });
});
