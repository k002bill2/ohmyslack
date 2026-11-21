import { useEffect, useState } from 'react';
import { makeChipThumbnail, thumbnailEdgePx } from './chip-thumbnail.js';
import type { ComposerChip } from './composer-upload.js';
import { composerKindLabel, extensionOf, maxBytesFor } from './file-kinds.js';

/** undefined = 생성 중, null = 실패(표지로 대체), string = 축소 data URL. */
type Thumb = string | null | undefined;

/**
 * 작성기 칩 맨 앞(D §6-5 「작성기 칩」): 이미지 칩은 미리보기 썸네일, 그 밖은 형식 표지 텍스트.
 * 썸네일 소스는 축소 data URL(CSP `img-src 'self' data:` — blob: 금지), 컴포넌트 상태(메모리)에만 둔다(B7).
 * 칩 키로 마운트되므로 같은 칩 재렌더에는 다시 만들지 않고, 언마운트·칩 교체 시 늦은 결과는 버린다.
 * 상한 초과 이미지는 디코딩하지 않고, 생성 중에는 같은 크기 빈 자리를 그리며, 실패면 확장자 대문자 표지로 대체한다.
 */
export function ChipLead({ chip }: { readonly chip: ComposerChip }) {
  const { file, kind } = chip;
  const image = kind === 'image';
  const decodable = image && file.size <= maxBytesFor('image');
  const [thumb, setThumb] = useState<Thumb>(undefined);
  useEffect(() => {
    if (!decodable) return undefined;
    const controller = new AbortController();
    setThumb(undefined);
    void makeChipThumbnail(file, thumbnailEdgePx(), controller.signal).then((url) => {
      if (!controller.signal.aborted) setThumb(url);
    });
    return () => controller.abort();
  }, [decodable, file]);
  if (decodable && thumb !== null) {
    return thumb === undefined ? (
      <span className="composer-chip-thumb" aria-hidden="true" />
    ) : (
      <img className="composer-chip-thumb" src={thumb} alt="" aria-hidden="true" onError={() => setThumb(null)} />
    );
  }
  const label = image ? extensionOf(file.name).toUpperCase() || null : composerKindLabel(file.name);
  return label === null ? null : <span className="composer-chip-kind">{label}</span>;
}
