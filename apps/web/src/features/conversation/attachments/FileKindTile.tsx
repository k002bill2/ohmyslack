import type { DocumentKind } from '../../../ui/copy.js';

/** 문서 형식 타일 색조 — 토큰 `--file-tile-{tone}`·`--on-file-tile-{tone}`(DESIGN_REFERENCE §3-3 「문서 형식 타일」). */
export type FileTileTone = 'green' | 'blue' | 'orange' | 'red' | 'cyan' | 'neutral';

/**
 * 형식(kind) → 타일 색조 대응의 유일한 표(UI_STATES §2-13). `Record`라 형식이 늘면 이 표에 한 줄이 빠질 때 타입 오류다.
 * 상표 색·로고를 흉내 내지 않는다(CLEANROOM) — 오픈 스케일의 일반 색조만 고른다.
 */
export const FILE_TILE_TONES: Readonly<Record<DocumentKind, FileTileTone>> = Object.freeze({
  pdf: 'red',
  word: 'blue',
  excel: 'green',
  powerpoint: 'orange',
  hwp: 'cyan',
  txt: 'neutral',
  md: 'neutral',
  csv: 'neutral',
});

/** 타일 글자 수 상한(확장자 대문자 앞부분). */
export const FILE_TILE_LABEL_MAX = 4;

/** 타일 글자: 확장자(점 없이) 대문자, 4자 초과는 앞 4자. 브랜드 이니셜을 쓰지 않는다. */
export function fileTileLabel(ext: string): string {
  return ext.replace(/^\./, '').toUpperCase().slice(0, FILE_TILE_LABEL_MAX);
}

export interface FileKindTileProps {
  readonly kind: DocumentKind;
  /** 확장자(점 없이). 메시지는 서버 판정 mime의 대표 확장자, 작성기는 파일명 확장자. */
  readonly ext: string;
  /** 업로드 중: 오른쪽 위 모서리 작은 원형 스피너(장식). 상태 문구는 칩의 「업로드 중」 텍스트가 맡는다. */
  readonly busy?: boolean;
}

/**
 * 문서 형식 타일(장식, `aria-hidden`): 둥근 정사각 2.5rem + 확장자 글자. 형식 이름은 옆 보조줄 텍스트가 읽힌다.
 * 색은 클래스로만 고른다(CSP `style-src 'self'` — 인라인 style 금지).
 */
export function FileKindTile({ kind, ext, busy = false }: FileKindTileProps) {
  return (
    <span className={`file-kind-tile file-tile-${FILE_TILE_TONES[kind]}`} aria-hidden="true">
      {fileTileLabel(ext)}
      {busy && <span className="file-kind-tile-spinner" />}
    </span>
  );
}
