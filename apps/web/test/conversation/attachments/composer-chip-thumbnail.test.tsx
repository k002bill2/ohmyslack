/**
 * 작성기 첨부 칩 이미지 미리보기 썸네일(D §6-5 「작성기 칩」): 메모리 전용 **축소 data URL**(CSP `img-src 'self' data:` 준수 — blob: 금지),
 * 생성 중 같은 크기 자리 박스, 늦은 결과는 버림, 상한 초과는 디코딩 없이 표지, 실패 시 형식 표지.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerAttachments } from '../../../src/features/conversation/attachments/ComposerAttachments.js';
import type { ComposerChip } from '../../../src/features/conversation/attachments/composer-upload.js';
import { maxBytesFor } from '../../../src/features/conversation/attachments/file-kinds.js';

const DATA_URL = 'data:image/webp;base64,UklGRg==';

type Bitmap = { readonly width: number; readonly height: number; readonly close: ReturnType<typeof vi.fn> };
const bitmap = (): Bitmap => ({ width: 200, height: 100, close: vi.fn() });

const createBitmap = vi.fn((_: Blob) => Promise.resolve(bitmap()));
const createObjectURL = vi.fn((_: Blob) => 'blob:should-not-be-used');
const drawImage = vi.fn();
let toDataURL: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  createBitmap.mockReset();
  createBitmap.mockImplementation(() => Promise.resolve(bitmap()));
  createObjectURL.mockClear();
  drawImage.mockClear();
  // jsdom에는 createImageBitmap·canvas 2D·object URL이 없다 — 테스트 동안만 붙이고 뒤에서 뗀다.
  Object.assign(globalThis, { createImageBitmap: createBitmap });
  Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({ drawImage }) as unknown as CanvasRenderingContext2D,
  );
  toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => DATA_URL);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, 'createImageBitmap');
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

const thumbImgs = (root: HTMLElement) => [...root.querySelectorAll<HTMLImageElement>('img.composer-chip-thumb')];
const slot = (root: HTMLElement) => root.querySelector('span.composer-chip-thumb');

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('작성기 칩 이미지 썸네일', () => {
  it('(a) 이미지 칩: img src가 data:image/ 축소 URL, 장식(alt 빈 값·aria-hidden), createObjectURL 호출 0, 형식 표지 없음', async () => {
    const { container } = render(view([chip(1, 'cat.png', 'image')]));
    await waitFor(() => expect(thumbImgs(container)).toHaveLength(1));
    const [img] = thumbImgs(container);
    expect(img?.getAttribute('src')?.startsWith('data:image/')).toBe(true);
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('aria-hidden')).toBe('true');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(createBitmap).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.composer-chip-kind')).toBeNull();
  });

  it('(a2) 축소: 캔버스 한 변은 128px 이하, 정사각 cover 크롭(원본 중앙 짧은 변), 비트맵 close', async () => {
    const bm = bitmap();
    createBitmap.mockImplementation(() => Promise.resolve(bm));
    const { container } = render(view([chip(1, 'wide.png', 'image')]));
    await waitFor(() => expect(thumbImgs(container)).toHaveLength(1));
    expect(drawImage).toHaveBeenCalledTimes(1);
    const [src, sx, sy, sw, sh, dx, dy, dw, dh] = drawImage.mock.calls[0] as [unknown, ...number[]];
    expect(src).toBe(bm);
    expect([sx, sy, sw, sh]).toEqual([50, 0, 100, 100]);
    expect([dx, dy]).toEqual([0, 0]);
    expect(dw).toBe(dh);
    expect(dw).toBeGreaterThan(0);
    expect(dw).toBeLessThanOrEqual(128);
    expect(bm.close).toHaveBeenCalledTimes(1);
  });

  it('(b) 문서·허용 밖 칩: img·자리 없음, 문서는 형식 표지 유지, 디코딩 호출 없음', () => {
    const { container } = render(view([chip(1, 'report.pdf', 'document', 'done'), chip(2, 'x.exe', null, 'failed')]));
    expect(container.querySelector('img')).toBeNull();
    expect(slot(container)).toBeNull();
    // 문서 칩 앞머리 = 형식 타일(장식) + 보조줄 형식 라벨. 이미지 대체 표지(.composer-chip-kind)는 쓰지 않는다.
    expect(container.querySelector('.composer-chip .file-kind-tile')?.textContent).toBe('PDF');
    expect(container.querySelector('.composer-chip-format')?.textContent).toBe('PDF');
    expect(container.querySelector('.composer-chip-kind')).toBeNull();
    expect(createBitmap).not.toHaveBeenCalled();
  });

  it('(c) 생성 중: 같은 크기 자리 박스(span.composer-chip-thumb, aria-hidden)만 그린다', async () => {
    const d = deferred<Bitmap>();
    createBitmap.mockImplementation(() => d.promise);
    const { container } = render(view([chip(1, 'cat.png', 'image')]));
    const box = slot(container);
    expect(box).not.toBeNull();
    expect(box?.getAttribute('aria-hidden')).toBe('true');
    expect(thumbImgs(container)).toHaveLength(0);
    expect(container.querySelector('.composer-chip-kind')).toBeNull();
    await act(async () => {
      d.resolve(bitmap());
      await d.promise;
    });
    await waitFor(() => expect(thumbImgs(container)).toHaveLength(1));
    expect(slot(container)).toBeNull();
  });

  it('(d) 언마운트 후 늦게 온 디코딩 결과는 버린다(캔버스 생성 없음, 비트맵 close)', async () => {
    const d = deferred<Bitmap>();
    createBitmap.mockImplementation(() => d.promise);
    const { unmount } = render(view([chip(1, 'a.png', 'image')]));
    unmount();
    const bm = bitmap();
    await act(async () => {
      d.resolve(bm);
      await d.promise;
    });
    await waitFor(() => expect(bm.close).toHaveBeenCalledTimes(1));
    expect(toDataURL).not.toHaveBeenCalled();
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('(e) 칩 교체(키 변경) 시 이전 칩의 늦은 결과는 새 칩에 반영되지 않는다', async () => {
    const first = deferred<Bitmap>();
    createBitmap.mockImplementationOnce(() => first.promise);
    const { container, rerender } = render(view([chip(1, 'a.png', 'image')]));
    rerender(view([chip(2, 'b.png', 'image')]));
    await waitFor(() => expect(thumbImgs(container)).toHaveLength(1));
    const late = bitmap();
    await act(async () => {
      first.resolve(late);
      await first.promise;
    });
    await waitFor(() => expect(late.close).toHaveBeenCalledTimes(1));
    expect(toDataURL).toHaveBeenCalledTimes(1);
    expect(thumbImgs(container)).toHaveLength(1);
  });

  it('(f) 같은 칩 재렌더(상태 변화 포함) 시 디코딩 추가 호출 없음', async () => {
    const a = chip(1, 'a.png', 'image');
    const { rerender, container } = render(view([a]));
    await waitFor(() => expect(thumbImgs(container)).toHaveLength(1));
    rerender(view([{ ...a, status: 'done' }]));
    rerender(view([{ ...a, status: 'failed', error: '실패' }]));
    expect(createBitmap).toHaveBeenCalledTimes(1);
    expect(thumbImgs(container)[0]?.getAttribute('src')).toBe(DATA_URL);
  });

  it('(g) 이미지 상한 초과 칩: 디코딩하지 않고 바로 형식 표지', () => {
    const big = chip(1, 'huge.png', 'image');
    Object.defineProperty(big.file, 'size', { value: maxBytesFor('image') + 1 });
    const { container } = render(view([big]));
    expect(createBitmap).not.toHaveBeenCalled();
    expect(slot(container)).toBeNull();
    expect(thumbImgs(container)).toHaveLength(0);
    expect(container.querySelector('.composer-chip-kind')?.textContent).toBe('PNG');
  });

  it('(h) 디코딩 실패(createImageBitmap 거부): 형식 표지(확장자 대문자)로 대체', async () => {
    createBitmap.mockImplementation(() => Promise.reject(new Error('decode')));
    const { container } = render(view([chip(1, 'broken.jpeg', 'image')]));
    await waitFor(() => expect(container.querySelector('.composer-chip-kind')?.textContent).toBe('JPEG'));
    expect(thumbImgs(container)).toHaveLength(0);
    expect(slot(container)).toBeNull();
  });

  it('(i) createImageBitmap 미지원: 형식 표지로 대체, createObjectURL 호출 0', async () => {
    Reflect.deleteProperty(globalThis, 'createImageBitmap');
    const { container } = render(view([chip(1, 'cat.gif', 'image')]));
    await waitFor(() => expect(container.querySelector('.composer-chip-kind')?.textContent).toBe('GIF'));
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('(j) img onError: 썸네일 숨김 → 형식 표지', async () => {
    const { container } = render(view([chip(1, 'x.webp', 'image')]));
    await waitFor(() => expect(thumbImgs(container)).toHaveLength(1));
    fireEvent.error(thumbImgs(container)[0] as HTMLImageElement);
    expect(thumbImgs(container)).toHaveLength(0);
    expect(container.querySelector('.composer-chip-kind')?.textContent).toBe('WEBP');
  });

  it('업로드 중 진행 표시는 기존 위치 유지(썸네일과 공존), 「첨부 제거」 접근 이름 불변', async () => {
    const { container, getByRole } = render(view([chip(1, 'cat.png', 'image')]));
    await waitFor(() => expect(thumbImgs(container)).toHaveLength(1));
    expect(container.querySelector('.composer-chip-state .composer-chip-progress')).not.toBeNull();
    expect(getByRole('button', { name: '첨부 제거: cat.png' })).toBeTruthy();
  });
});

describe('썸네일 스킴 ↔ 서버 CSP img-src 정합(회귀 방지)', () => {
  // 서버 코드는 import하지 않고(패키지 경계) 원문에서 CSP 문자열의 img-src 지시어만 읽는다.
  // jsdom 환경의 import.meta.url은 file: 스킴이 아니다 — 웹 패키지 루트(vitest cwd) 기준 경로로 읽는다.
  const securityTs = readFileSync(resolve(process.cwd(), '../server/src/http/security.ts'), 'utf8');
  const imgSrc = /img-src ([^;"]+)/.exec(securityTs)?.[1]?.trim().split(/\s+/) ?? [];

  it('서버 CSP에 img-src 지시어가 있다', () => {
    expect(imgSrc.length).toBeGreaterThan(0);
  });

  it('렌더된 썸네일 src의 스킴이 img-src 허용 목록에 있다', async () => {
    const { container } = render(view([chip(1, 'cat.png', 'image')]));
    await waitFor(() => expect(thumbImgs(container)).toHaveLength(1));
    const scheme = new URL(thumbImgs(container)[0]?.getAttribute('src') ?? '').protocol;
    expect(imgSrc).toContain(scheme);
  });
});
