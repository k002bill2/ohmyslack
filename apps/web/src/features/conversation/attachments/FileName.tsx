import { splitFilename } from './file-kinds.js';

/**
 * 파일명 말줄임 규칙(UI_STATES §2-13): 이름부만 줄이고 확장자부(마지막 `.` 이후, 점 포함)는 줄이지 않는다.
 * 메시지 문서 행(CMP-32)과 작성기 칩이 같이 쓴다. 클래스는 `{base}`·`{base}-stem`·`{base}-ext`, 전체 파일명은 `title`.
 */
export function FileName({ name, base }: { readonly name: string; readonly base: string }) {
  const { stem, ext } = splitFilename(name);
  return (
    <span className={base} title={name}>
      <span className={`${base}-stem`}>{stem}</span>
      {ext !== '' && <span className={`${base}-ext`}>{ext}</span>}
    </span>
  );
}
