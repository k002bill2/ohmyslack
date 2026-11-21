/** 작성기 첨부 칩 이미지 미리보기 썸네일(D §6-5 「작성기 칩」): 메모리 전용 object URL, 칩 사라짐·언마운트 시 revoke, 재렌더 재생성 없음, 디코딩 실패 시 형식 표지. */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerAttachments } from '../../../src/features/conversation/attachments/ComposerAttachments.js';
import type { ComposerChip } from '../../../src/features/conversation/attachments/composer-upload.js';

let seq = 0;
const create = vi.fn((_: Blob) => `blob:thumb-${++seq}`);
const revoke = vi.fn((_: string) => undefined);

beforeEach(() => {
  seq = 0;
  create.mockClear();
  revoke.mockClear();
  // jsdom에는 object URL API가 없다 — 테스트 동안만 붙이고 뒤에서 뗀다.
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

function chip(key: number, name: string, kind: ComposerChip['kind'], status: ComposerChip['status'] = 'uploading'): ComposerChip {
  return { key, file: new File([new Uint8Array(4)], name), status, kind };
}

const noop = () => undefined;
function view(chips: readonly ComposerChip[]) {
  return <ComposerAttachments chips={chips} full={false} uploading={false} onAdd={noop} onRemove={noop} onRetry={noop} />;
}

const thumbs = (root: HTMLElement) => [...root.querySelectorAll<HTMLImageElement>('.composer-chip-thumb')];

describe('작성기 칩 이미지 썸네일', () => {
  it('(a) 이미지 칩: img가 createObjectURL 결과를 src로, 장식(alt 빈 값·aria-hidden), 형식 표지 없음', () => {
    const { container } = render(view([chip(1, 'cat.png', 'image')]));
    const [img] = thumbs(container);
    expect(img).toBeDefined();
    expect(img?.getAttribute('src')).toBe('blob:thumb-1');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('aria-hidden')).toBe('true');
    expect(create).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.composer-chip-kind')).toBeNull();
  });

  it('(b) 문서·허용 밖 칩: img 없음, 문서는 형식 표지 유지, createObjectURL 호출 없음', () => {
    const { container } = render(view([chip(1, 'report.pdf', 'document', 'done'), chip(2, 'x.exe', null, 'failed')]));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.composer-chip-kind')?.textContent).toBe('PDF');
    expect(create).not.toHaveBeenCalled();
  });

  it('(c) 칩 제거 시 그 칩의 URL만 revoke', () => {
    const a = chip(1, 'a.png', 'image');
    const b = chip(2, 'b.jpg', 'image');
    const { rerender } = render(view([a, b]));
    expect(revoke).not.toHaveBeenCalled();
    rerender(view([b]));
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:thumb-1');
  });

  it('(d) 언마운트 시 남은 URL 모두 revoke', () => {
    const { unmount } = render(view([chip(1, 'a.png', 'image'), chip(2, 'b.webp', 'image')]));
    unmount();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke.mock.calls.map((c) => c[0]).sort()).toEqual(['blob:thumb-1', 'blob:thumb-2']);
  });

  it('(e) 같은 칩 재렌더(상태 변화 포함) 시 createObjectURL 추가 호출 없음', () => {
    const a = chip(1, 'a.png', 'image');
    const { rerender, container } = render(view([a]));
    rerender(view([{ ...a, status: 'done' }]));
    rerender(view([{ ...a, status: 'failed', error: '실패' }]));
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    expect(thumbs(container)[0]?.getAttribute('src')).toBe('blob:thumb-1');
  });

  it('(f) 디코딩 실패(onError): 썸네일 숨김 → 형식 표지(확장자 대문자) 텍스트로 대체', () => {
    const { container } = render(view([chip(1, 'broken.jpeg', 'image')]));
    const [img] = thumbs(container);
    fireEvent.error(img as HTMLImageElement);
    expect(thumbs(container)).toHaveLength(0);
    expect(container.querySelector('.composer-chip-kind')?.textContent).toBe('JPEG');
  });

  it('업로드 중 진행 표시는 기존 위치 유지(썸네일과 공존), 「첨부 제거」 접근 이름 불변', () => {
    const { container, getByRole } = render(view([chip(1, 'cat.png', 'image')]));
    expect(thumbs(container)).toHaveLength(1);
    expect(container.querySelector('.composer-chip-state .composer-chip-progress')).not.toBeNull();
    expect(getByRole('button', { name: '첨부 제거: cat.png' })).toBeTruthy();
  });
});
