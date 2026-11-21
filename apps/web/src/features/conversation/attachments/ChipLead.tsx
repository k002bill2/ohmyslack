import { useEffect, useState } from 'react';
import type { ComposerChip } from './composer-upload.js';
import { composerKindLabel, extensionOf } from './file-kinds.js';

/**
 * 작성기 칩 맨 앞(D §6-5 「작성기 칩」): 이미지 칩은 미리보기 썸네일, 그 밖은 형식 표지 텍스트.
 * 썸네일 소스는 메모리 전용 object URL(B7 — 지속 저장 없음). 칩 키로 마운트되므로 같은 칩 재렌더에는 새 URL을 만들지 않고,
 * 칩이 사라지거나(제거·전송·대화 전환) 언마운트되면 revoke한다. 디코딩 실패면 확장자 대문자 표지로 대체한다.
 */
export function ChipLead({ chip }: { readonly chip: ComposerChip }) {
  const { file, kind } = chip;
  const [url, setUrl] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const image = kind === 'image';
  useEffect(() => {
    if (!image) return undefined;
    const created = URL.createObjectURL(file);
    setUrl(created);
    return () => {
      URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [image, file]);
  if (image && !broken) {
    return url === null ? null : (
      <img className="composer-chip-thumb" src={url} alt="" aria-hidden="true" onError={() => setBroken(true)} />
    );
  }
  const label = image ? extensionOf(file.name).toUpperCase() || null : composerKindLabel(file.name);
  return label === null ? null : <span className="composer-chip-kind">{label}</span>;
}
