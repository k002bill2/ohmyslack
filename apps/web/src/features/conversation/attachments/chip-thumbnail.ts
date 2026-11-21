/** 작성기 칩 썸네일(D §6-5): 서버 CSP `img-src 'self' data:`를 지키려 blob: 대신 작은 data URL로 만든다. */

/** 썸네일 한 변(CSS 2.5rem, .composer-chip-thumb)과 캔버스 상한(px). */
const THUMB_EDGE_REM = 2.5;
const THUMB_MAX_PX = 128;
const FALLBACK_ROOT_PX = 16;

/** 캔버스 한 변(px) = 2.5rem × devicePixelRatio, 상한 128. */
export function thumbnailEdgePx(): number {
  const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || FALLBACK_ROOT_PX;
  const dpr = window.devicePixelRatio || 1;
  return Math.max(1, Math.min(THUMB_MAX_PX, Math.round(THUMB_EDGE_REM * rootPx * dpr)));
}

function drawCover(bitmap: ImageBitmap, edge: number): string | null {
  const side = Math.min(bitmap.width, bitmap.height);
  if (side <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, edge, edge);
  const webp = canvas.toDataURL('image/webp', 0.8);
  // webp 미지원 브라우저는 PNG로 돌려준다 — 그 경우만 PNG로 다시 뽑는다.
  const url = webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
  return url.startsWith('data:image/') ? url : null;
}

/**
 * 파일을 정사각 cover로 크롭·축소한 data URL. 디코딩 불가·API 없음·취소면 null.
 * 원본 크기 data URL은 만들지 않고, 비트맵은 항상 close한다. 결과는 메모리에만 둔다(B7).
 */
export async function makeChipThumbnail(file: Blob, edge: number, signal: AbortSignal): Promise<string | null> {
  if (typeof globalThis.createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await globalThis.createImageBitmap(file);
    if (signal.aborted) return null;
    return drawCover(bitmap, edge);
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
