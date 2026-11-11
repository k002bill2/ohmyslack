import { AUTHOR_NAME_COPY } from './copy.js';

/**
 * 비활성 이름 표시(QA D2·D3): 이름 span + 접미 span(「(비활성)」 한 덩어리, 줄지 않음). 사이 공백은 텍스트 노드로 남겨
 * textContent·접근 이름이 `AUTHOR_NAME_COPY.inactive(이름)`과 같다. 활성이거나 `label`이 그 문구와 다르면 `label` 그대로 —
 * 문자열을 쪼개지 않고, 데이터가 준 접미 없는 이름(`inactiveName`)으로만 나눈다.
 */
export function NameParts({ label, inactiveName }: { readonly label: string; readonly inactiveName?: string | undefined }) {
  if (!isSplitName(label, inactiveName)) return <>{label}</>;
  return (
    <>
      <span className="name-base">{inactiveName}</span> <span className="name-suffix">{AUTHOR_NAME_COPY.inactiveSuffix}</span>
    </>
  );
}

/** `NameParts`가 이름·접미로 나눠 그리는가 — 말줄임 컨테이너(`.name-split`)·`title`을 붙일지 정한다. */
export function isSplitName(label: string, inactiveName: string | undefined): inactiveName is string {
  return inactiveName !== undefined && label === AUTHOR_NAME_COPY.inactive(inactiveName);
}
