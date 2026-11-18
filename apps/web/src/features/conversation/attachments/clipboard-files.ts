import { composerFileKind, imageExtensionFor } from './file-kinds.js';

/** 붙여넣기 판정에 쓰는 클립보드 모양(`DataTransfer`의 부분집합 — 테스트에서 흉내 낼 수 있게). */
export interface ClipboardLike {
  readonly files: ArrayLike<File>;
  readonly items?: ArrayLike<{ readonly kind: string; getAsFile(): File | null }>;
  getData(format: string): string;
}

/** 이름이 비었거나 확장자가 허용 밖인 허용 이미지는 브라우저 관례 이름 `image.<ext>`로 바꾼다. 그 외는 그대로. */
function named(file: File): File {
  const ext = imageExtensionFor(file.type);
  if (ext === null || (file.name !== '' && composerFileKind(file.name) !== null)) return file;
  return new File([file], `image.${ext}`, { type: file.type });
}

/**
 * 작성기 붙여넣기에서 첨부할 파일들. null이면 가로채지 않고 기본 붙여넣기에 맡긴다.
 * - 파일은 `files` 우선, 비면 `items`의 `kind === 'file'` → `getAsFile()`(null 제외).
 * - 파일이 없거나, 파일과 함께 비어 있지 않은 `text/plain`이 있으면(표 복사 등) null — 텍스트 우선.
 *   단 그 텍스트가 공백뿐이거나 파일 원래 이름 목록과 같으면(Finder 복사) 첨부한다.
 * 허용 형식·용량·개수 판정은 하지 않는다(첨부 초안 저장소 규칙을 그대로 따른다).
 */
export function pastedFiles(data: ClipboardLike | null): File[] | null {
  if (data === null) return null;
  const direct = Array.from(data.files);
  const files =
    direct.length > 0
      ? direct
      : Array.from(data.items ?? [])
          .filter((item) => item.kind === 'file')
          .map((item) => item.getAsFile())
          .filter((f): f is File => f !== null);
  if (files.length === 0) return null;
  if (!textIsEmptyOrFileNames(data.getData('text/plain'), files)) return null;
  return files.map(named);
}

/** `text/plain`이 비었거나(공백뿐 포함), 줄 단위 목록이 수집한 파일의 원래 이름 집합과 같으면(Finder 복사) true. */
function textIsEmptyOrFileNames(text: string, files: readonly File[]): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) return true;
  if (lines.length !== files.length) return false;
  const names = files.map((f) => f.name).sort();
  return [...lines].sort().every((l, i) => l === names[i]);
}
