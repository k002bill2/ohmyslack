/**
 * 웹 디자인 토큰 — 정본: DESIGN_REFERENCE R3.1 §3-1(출처)·§3-2(타이포)·§3-3(색)·§3-4(아이콘)·§3-5(간격·모션)·§7-1(대비).
 * 형식 계약: tools/check-design-tokens.ts 머리 주석(`tokens.colors.{light,dark}`·`fonts`·`icons`).
 * 이 파일은 외부 import 없이 순수 상수만 둔다(체커가 tsx로 동적 import).
 */

const RADIX_SOURCE = 'https://raw.githubusercontent.com/radix-ui/colors/main/LICENSE';
const RADIX_LICENSE = 'MIT';
/** Open Color(MIT) `white` — Radix 12단계에 없는 순백. 채운 버튼 위 글자 대비(teal11 4.56·red11 5.21)에만 쓴다. */
const OPEN_COLOR_SOURCE = 'https://raw.githubusercontent.com/yeun/open-color/master/LICENSE';
const OPEN_COLOR_WHITE = '#ffffff';

export type Scheme = 'light' | 'dark';
export type ScaleName = 'slate' | 'teal' | 'green' | 'amber' | 'red';
export type ColorRole = 'surface' | 'text' | 'nontext';
type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/**
 * Radix Colors 공식 값(MIT). 원본: github.com/radix-ui/colors `src/light.ts`·`src/dark.ts` (2026-11-07 취득).
 * 인덱스 0 = step 1. neutral = slate, accent = teal(§3-3 기본값), 상태색 green·amber·red(§3-3 역할 표).
 */
export const radixScales: Readonly<Record<Scheme, Readonly<Record<ScaleName, readonly string[]>>>> = Object.freeze({
  light: {
    slate: ['#fcfcfd', '#f9f9fb', '#f0f0f3', '#e8e8ec', '#e0e1e6', '#d9d9e0', '#cdced6', '#b9bbc6', '#8b8d98', '#80838d', '#60646c', '#1c2024'],
    teal: ['#fafefd', '#f3fbf9', '#e0f8f3', '#ccf3ea', '#b8eae0', '#a1ded2', '#83cdc1', '#53b9ab', '#12a594', '#0d9b8a', '#008573', '#0d3d38'],
    green: ['#fbfefc', '#f4fbf6', '#e6f6eb', '#d6f1df', '#c4e8d1', '#adddc0', '#8eceaa', '#5bb98b', '#30a46c', '#2b9a66', '#218358', '#193b2d'],
    amber: ['#fefdfb', '#fefbe9', '#fff7c2', '#ffee9c', '#fbe577', '#f3d673', '#e9c162', '#e2a336', '#ffc53d', '#ffba18', '#ab6400', '#4f3422'],
    red: ['#fffcfc', '#fff7f7', '#feebec', '#ffdbdc', '#ffcdce', '#fdbdbe', '#f4a9aa', '#eb8e90', '#e5484d', '#dc3e42', '#ce2c31', '#641723'],
  },
  dark: {
    slate: ['#111113', '#18191b', '#212225', '#272a2d', '#2e3135', '#363a3f', '#43484e', '#5a6169', '#696e77', '#777b84', '#b0b4ba', '#edeef0'],
    teal: ['#0d1514', '#111c1b', '#0d2d2a', '#023b37', '#084843', '#145750', '#1c6961', '#207e73', '#12a594', '#0eb39e', '#0bd8b6', '#adf0dd'],
    green: ['#0e1512', '#121b17', '#132d21', '#113b29', '#174933', '#20573e', '#28684a', '#2f7c57', '#30a46c', '#33b074', '#3dd68c', '#b1f1cb'],
    amber: ['#16120c', '#1d180f', '#302008', '#3f2700', '#4d3000', '#5c3d05', '#714f19', '#8f6424', '#ffc53d', '#ffd60a', '#ffca16', '#ffe7b3'],
    red: ['#191111', '#201314', '#3b1219', '#500f1c', '#611623', '#72232d', '#8c333a', '#b54548', '#e5484d', '#ec5d5e', '#ff9592', '#ffd1d9'],
  },
});

export interface ColorToken {
  readonly value: string;
  readonly role: ColorRole;
  /** text·nontext 대비 계산 대상(같은 스킴의 surface 토큰 이름). */
  readonly on?: string;
  /** Radix 스케일. Open Color 고정값(순백)이면 'open-color'이고 step·canonStep이 없다. */
  readonly scale: ScaleName | 'open-color';
  readonly step?: Step;
  /** §3-3 표의 (스킴별) 단계. step과 다르면 §7-1 대비 미달로 바꾼 것(deviation에 사유). */
  readonly canonStep?: Step;
  readonly deviation?: string;
  readonly source: string;
  readonly license: string;
}

interface RoleSpec {
  readonly scale: ScaleName;
  readonly step: Step;
  readonly role: ColorRole;
  readonly on?: string;
  /** §3-3 표의 다크 열(라이트와 다른 스케일·단계를 정본으로 둔 역할만). 대비 사유가 아니라 시안 정본이다. */
  readonly dark?: { readonly scale?: ScaleName; readonly step: Step };
  /** §3-3 표의 라이트 열이 Open Color 순백인 역할(채운 면 위 글자). */
  readonly lightWhite?: true;
  /** 스킴별 단계 대체(§3-3 단계가 §7-1 대비 기준 미달인 경우만). */
  readonly override?: Partial<Record<Scheme, { readonly step: Step; readonly reason: string }>>;
}

const BG_APP = '--bg-app';

/** §3-3 역할 표(이름·스케일·단계 정본 그대로). override만 정본과 다르다 — REPORT "정본 오류" 참조. */
const ROLE_SPECS: Readonly<Record<string, RoleSpec>> = {
  /** 시안 R5(아티팩트 7266210d 재반영): 다크는 패널 slate2·바닥(ground) slate1 — 라이트(패널 1·바닥 3)와 밝기 관계를 맞춘다. */
  '--bg-app': { scale: 'slate', step: 1, role: 'surface', dark: { step: 2 } },
  '--bg-sidebar': { scale: 'slate', step: 2, role: 'surface' },
  '--bg-elevated': { scale: 'slate', step: 3, role: 'surface', dark: { step: 1 } },
  '--bg-hover': { scale: 'slate', step: 4, role: 'surface' },
  '--bg-active': { scale: 'slate', step: 5, role: 'surface' },
  /**
   * 장식 구분선·패널 테두리(시안 R5 slate6). 컴포넌트 식별 경계가 아니라 WCAG 1.4.11 대비 대상 밖(§2-3 4항 예외) —
   * --danger-line과 같이 surface 역할. 조작 대상의 유일한 경계(입력란·분할 손잡이)는 --border를 쓴다.
   */
  '--border-subtle': { scale: 'slate', step: 6, role: 'surface' },
  '--border': {
    scale: 'slate', step: 7, role: 'nontext', on: BG_APP,
    override: {
      light: { step: 9, reason: 'slate7/bg-app 1.53 < 3 (§7-1 1.4.11)' },
      dark: { step: 9, reason: 'slate7/bg-app(slate2) 1.9 < 3, slate8 2.81 < 3 (§7-1 1.4.11)' },
    },
  },
  '--text-muted': { scale: 'slate', step: 11, role: 'text', on: BG_APP },
  '--text': { scale: 'slate', step: 12, role: 'text', on: BG_APP },
  '--accent-solid': {
    scale: 'teal', step: 9, role: 'nontext', on: BG_APP,
    override: { light: { step: 10, reason: 'teal9/bg-app 2.996 < 3 (§7-1 1.4.11)' } },
  },
  '--accent-text': {
    scale: 'teal', step: 11, role: 'text', on: BG_APP,
    override: { light: { step: 12, reason: 'teal11/bg-app 4.45 < 4.5 (§7-1 1.4.3)' } },
  },
  '--accent-bg': { scale: 'teal', step: 3, role: 'surface' },
  '--success-text': { scale: 'green', step: 11, role: 'text', on: BG_APP },
  '--warning-bg': { scale: 'amber', step: 3, role: 'surface' },
  '--warning-text': {
    scale: 'amber', step: 11, role: 'text', on: '--warning-bg',
    override: { light: { step: 12, reason: 'amber11/amber3 4.25 < 4.5 (§7-1 1.4.3)' } },
  },
  /** 시안 01 「여기부터 새 메시지」 라벨 바탕(red 3). danger-text 11/3 대비 light 4.54·dark 7.75. */
  '--danger-bg': { scale: 'red', step: 3, role: 'surface' },
  '--danger-text': { scale: 'red', step: 11, role: 'text', on: BG_APP },
  '--danger-solid': { scale: 'red', step: 9, role: 'nontext', on: BG_APP },
  /** 시안 R5 채운 버튼(로그인·기본 버튼·전송·멘션 배지): 라이트 teal11·다크 teal9. 글자는 --on-accent-strong. */
  '--accent-strong': { scale: 'teal', step: 11, role: 'surface', dark: { step: 9 } },
  '--on-accent-strong': {
    scale: 'slate', step: 1, role: 'text', on: '--accent-strong', lightWhite: true,
  },
  /** 시안 R5 위험 확인 버튼: 라이트 red11·다크 red9 면 + --on-danger-strong 글자. */
  '--danger-strong': { scale: 'red', step: 11, role: 'surface', dark: { step: 9 } },
  '--on-danger-strong': {
    scale: 'slate', step: 1, role: 'text', on: '--danger-strong', lightWhite: true,
  },
  /** 시안 R5 「여기부터 새 메시지」 구분선(red 6, 장식 — 라벨이 의미를 전달). */
  '--danger-line': { scale: 'red', step: 6, role: 'surface' },
  /** 시안 R5 본문 @멘션 글자: 라이트 slate12(굵게)·다크 teal11. 멘션 블록(--accent-bg) 위. */
  '--mention-text': { scale: 'slate', step: 12, role: 'text', on: '--accent-bg', dark: { scale: 'teal', step: 11 } },
  '--focus-ring': {
    scale: 'teal', step: 8, role: 'nontext', on: BG_APP,
    override: { light: { step: 10, reason: 'teal8/bg-app 2.30 < 3 (§7-1 1.4.11)' } },
  },
};

/** §3-3 역할 토큰 이름(정본 표 순서). */
export const ROLE_TOKEN_NAMES: readonly string[] = Object.freeze(Object.keys(ROLE_SPECS));

function buildToken(spec: RoleSpec, scheme: Scheme): ColorToken {
  const on = spec.on === undefined ? {} : { on: spec.on };
  if (scheme === 'light' && spec.lightWhite === true) {
    return Object.freeze({
      value: OPEN_COLOR_WHITE, role: spec.role, scale: 'open-color' as const, ...on,
      source: OPEN_COLOR_SOURCE, license: 'MIT',
    });
  }
  const canon = scheme === 'dark' && spec.dark !== undefined ? spec.dark : spec;
  const scale = canon.scale ?? spec.scale;
  const over = spec.override?.[scheme];
  const step = over?.step ?? canon.step;
  const value = radixScales[scheme][scale][step - 1];
  if (value === undefined) throw new Error(`radix ${scheme}.${scale}${step} 없음`);
  return Object.freeze({
    value, role: spec.role, scale, step, canonStep: canon.step, ...on,
    ...(over === undefined ? {} : { deviation: over.reason }),
    source: RADIX_SOURCE, license: RADIX_LICENSE,
  });
}

function buildScheme(scheme: Scheme): Readonly<Record<string, ColorToken>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(ROLE_SPECS).map(([name, spec]) => [name, buildToken(spec, scheme)]),
  ));
}

export interface ProvenanceEntry {
  readonly name: string;
  readonly source: string;
  readonly license: string;
}

/**
 * §3-1 폰트 행. Pretendard는 v1.3.9 공식 웹 빌드 `PretendardVariable.woff2`를 무수정 동봉한다
 * (`apps/web/public/fonts/` — LICENSE.txt·SOURCES.md 함께, @font-face는 `src/ui/base.css`). 나머지는 폴백 스택 이름만(파일 미동봉).
 */
const FONTS: readonly ProvenanceEntry[] = [
  { name: 'Pretendard', source: 'https://raw.githubusercontent.com/orioncactus/pretendard/main/LICENSE', license: 'OFL-1.1' },
  { name: 'Noto Sans KR', source: 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE', license: 'OFL-1.1' },
  { name: 'JetBrains Mono', source: 'https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt', license: 'OFL-1.1' },
];

const LUCIDE_SOURCE = 'https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE';
/** §3-4에서 ✅(확인됨)인 Lucide 이름만. ⚠️ 항목은 빌드 시 확정(REPORT 목록). */
const ICON_NAMES = [
  'hash', 'message-square', 'user', 'lock', 'at-sign', 'send', 'reply', 'corner-up-left',
  'x', 'chevron-left', 'clock', 'check', 'refresh-cw', 'wifi-off', 'pencil', 'trash',
  'ellipsis', 'search', 'settings', 'log-out', 'plus', 'smartphone', 'copy',
] as const;

/** §3-2 그대로. */
const TYPOGRAPHY: Readonly<Record<string, string>> = {
  '--font-sans': '"Pretendard Variable", Pretendard, "Noto Sans KR", -apple-system, BlinkMacSystemFont, system-ui, "Apple SD Gothic Neo", sans-serif',
  '--font-mono': '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  '--text-xs': '0.75rem',
  '--text-sm': '0.8125rem',
  '--text-md': '0.9375rem',
  '--text-lg': '1.0625rem',
  '--text-xl': '1.25rem',
  '--leading-body': '1.55',
  '--leading-tight': '1.3',
};

/** §3-5 그대로. */
const SPACE: Readonly<Record<string, string>> = {
  '--space-1': '0.25rem', '--space-2': '0.5rem', '--space-3': '0.75rem', '--space-4': '1rem',
  '--space-5': '1.25rem', '--space-6': '1.5rem', '--space-8': '2rem', '--space-10': '2.5rem',
};
/** §3-5. xl·2xl·float·overlay는 R4 디자인 시안(떠 있는 패널·작성기·다이얼로그) 반영으로 추가. */
const RADIUS: Readonly<Record<string, string>> = {
  '--radius-sm': '4px', '--radius-md': '8px', '--radius-lg': '12px', '--radius-xl': '16px', '--radius-2xl': '20px',
};
const SHADOW: Readonly<Record<string, string>> = {
  '--shadow-popover': '0 4px 16px rgb(0 0 0 / 0.12)',
  '--shadow-float': '0 8px 24px rgb(0 0 0 / 0.10)',
  '--shadow-overlay': '0 16px 48px rgb(0 0 0 / 0.14)',
};
const MOTION: Readonly<Record<string, string>> = { '--motion-fast': '120ms', '--motion-base': '200ms' };
/** §3-5 `prefers-reduced-motion: reduce` 값. */
const MOTION_REDUCED: Readonly<Record<string, string>> = { '--motion-fast': '0ms', '--motion-base': '0ms' };

export const tokens = Object.freeze({
  colors: Object.freeze({ light: buildScheme('light'), dark: buildScheme('dark') }),
  fonts: Object.freeze(FONTS.map((f) => Object.freeze({ ...f }))),
  icons: Object.freeze(ICON_NAMES.map((name) => Object.freeze({ name, source: LUCIDE_SOURCE, license: 'ISC' }))),
  typography: Object.freeze({ ...TYPOGRAPHY }),
  space: Object.freeze({ ...SPACE }),
  radius: Object.freeze({ ...RADIUS }),
  shadow: Object.freeze({ ...SHADOW }),
  motion: Object.freeze({ ...MOTION }),
  motionReduced: Object.freeze({ ...MOTION_REDUCED }),
});

/**
 * §5-1 구간 경계·§5-2 접힘 경계(px). 구간 판정은 이 상수로만 한다(개발설계서 A5 — 1곳에만 둔다).
 * compact: width ≤ compactMax / medium: compactMax < width < wideMin / wide: width ≥ wideMin.
 * 스레드 열림 + width < threadRoomyMin → 사이드바 72px 자동 접힘(§5-2 필수).
 */
export const breakpoints = Object.freeze({ compactMax: 640, wideMin: 1024, threadRoomyMin: 1120 });

/** §5-1 Media Queries Level 4 범위 문법(상수에서 생성). */
export const mediaQueries = Object.freeze({
  compact: `(width <= ${breakpoints.compactMax}px)`,
  medium: `(${breakpoints.compactMax}px < width < ${breakpoints.wideMin}px)`,
  wide: `(width >= ${breakpoints.wideMin}px)`,
  threadRoomy: `(width >= ${breakpoints.threadRoomyMin}px)`,
});

/** R4 스레드 최소 폭 — CSS(--thread-min)와 분할 계산(splitLimits.threadMin)이 같은 값을 쓴다. */
const THREAD_MIN = 320;

/** §5-2·§5-3 레이아웃 폭 토큰 그대로. */
export const layoutVars: Readonly<Record<string, string>> = Object.freeze({
  '--sidebar-w': '260px',
  '--sidebar-w-collapsed': '72px',
  '--thread-w': 'clamp(320px, 32vw, 380px)',
  '--thread-min': `${THREAD_MIN}px`,
  '--body-min': '480px',
  '--body-min-medium': '380px',
  '--thread-overlay-w': 'min(420px, 100%)',
});

/**
 * R4 분할선(wide 전용, DESIGN_REFERENCE §5-2 R4): 사용자가 끌어 내비·스레드 폭을 바꾼다. 기본 폭은 위 layoutVars 그대로.
 * 내비를 navCollapseBelow 아래로 끌면 72px 레일로 접힌다. 본문은 bodyMin 아래로 줄지 않는다. 키보드 ←→는 step씩, Home/End는 최소/최대.
 */
export const splitLimits = Object.freeze({
  navMin: 200,
  navMax: 360,
  navCollapseBelow: 160,
  threadMin: THREAD_MIN,
  bodyMin: 480,
  /** 분할선 자체 폭(= 패널 사이 여백). */
  gutter: 12,
  step: 16,
});
