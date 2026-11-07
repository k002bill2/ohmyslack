/**
 * check:design-tokens — DESIGN_REFERENCE §2-3(기계 검증)·§3-1(출처 표)·§7-1(대비) 규칙 검사.
 *
 * 토큰 모듈 계약(`<root>/apps/web/src/ui/tokens.ts`):
 *   export const tokens = {
 *     colors: { light: Record<string, ColorToken>, dark: Record<string, ColorToken> },
 *     fonts: Array<{ name: string, source: string, license: string }>,
 *     icons: Array<{ name: string, source: string, license: string }>,
 *   };
 *   ColorToken = {
 *     value: '#rrggbb', role: 'surface' | 'text' | 'nontext',
 *     on?: '<같은 스킴의 surface 토큰 이름>',   // text·nontext는 필수(대비 계산 대상)
 *     source: string, license: string,           // source는 §3-1 표 URL 중 하나
 *   };
 * 토큰 모듈이 없으면 "토큰 모듈 미구현"을 출력하고 토큰 검사는 건너뛴다(에셋·매니페스트 검사는 항상 실행).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFlags, type RunContext } from './lib/cli.ts';

/** §2-3 3항: 면 역할 금지 색 범위. */
export const FORBIDDEN_HUE_MIN = 280;
export const FORBIDDEN_HUE_MAX = 330;
export const FORBIDDEN_LIGHTNESS_MAX = 35;
export const FORBIDDEN_SATURATION_MIN = 40;
/** §7-1: WCAG 1.4.3 / 1.4.11. */
export const MIN_CONTRAST_TEXT = 4.5;
export const MIN_CONTRAST_NONTEXT = 3;
/** §2-3 5항. */
export const FORBIDDEN_NAME = 'slack';
export const SCHEMES = ['light', 'dark'] as const;

/** §3-1 표 "확인한 원문" URL(스킴 제외 host+path). 저장소 약칭 행은 raw.githubusercontent.com 호스트로 확장. */
export const ALLOWED_SOURCES: readonly string[] = [
  'raw.githubusercontent.com/orioncactus/pretendard/main/LICENSE',
  'openfontlicense.org/open-font-license-official-text',
  'raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE',
  'raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt',
  'raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE',
  'lucide.dev/license',
  'raw.githubusercontent.com/phosphor-icons/core/main/LICENSE',
  'raw.githubusercontent.com/tabler/tabler-icons/main/LICENSE',
  'raw.githubusercontent.com/radix-ui/colors/main/LICENSE',
  'raw.githubusercontent.com/yeun/open-color/master/LICENSE',
  'raw.githubusercontent.com/tailwindlabs/tailwindcss/main/LICENSE',
];

const ASSET_EXT = /\.(png|jpg|svg|ico|webp|woff|woff2|mp3|wav|ogg)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg)$/i;
// `.claude`: 에이전트 도구가 만드는 미추적 worktree 사본(저장소 산출물 아님)
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', 'dist-measure', 'reports', 'coverage', 'dev']);
const TOKENS_REL = 'apps/web/src/ui/tokens.ts';
const MANIFEST_REL = 'apps/web/public/manifest.webmanifest';

type Rgb = readonly [number, number, number];

export function normalizeSource(url: string): string {
  return url.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

export function isAllowedSource(url: string): boolean {
  return ALLOWED_SOURCES.includes(normalizeSource(url));
}

export function parseHex(value: unknown): Rgb | undefined {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return undefined;
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** HSL: h 0–360, s·l 0–100. */
export function toHsl([r, g, b]: Rgb): { h: number; s: number; l: number } {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rr) h = ((gg - bb) / d) % 6;
  else if (max === gg) h = (bb - rr) / d + 2;
  else h = (rr - gg) / d + 4;
  return { h: (h * 60 + 360) % 360, s: s * 100, l: l * 100 };
}

export function isForbiddenSurface(rgb: Rgb): boolean {
  const { h, s, l } = toHsl(rgb);
  return h >= FORBIDDEN_HUE_MIN && h <= FORBIDDEN_HUE_MAX
    && l <= FORBIDDEN_LIGHTNESS_MAX && s >= FORBIDDEN_SATURATION_MIN;
}

/** WCAG 2.x relative luminance. */
export function luminance(rgb: Rgb): number {
  const ch = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function checkProvenance(label: string, entry: Record<string, unknown>): string[] {
  const source = str(entry['source']);
  const license = str(entry['license']);
  const out: string[] = [];
  if (source === '') out.push(`${label}: source 없음`);
  else if (!isAllowedSource(source)) out.push(`${label}: §3-1 표에 없는 source (${source})`);
  if (license === '') out.push(`${label}: license 없음`);
  return out;
}

function checkColor(
  label: string, tok: Record<string, unknown>, scheme: Record<string, unknown>,
): string[] {
  const out = checkProvenance(label, tok);
  const rgb = parseHex(tok['value']);
  const role = tok['role'];
  if (rgb === undefined) return [...out, `${label}: value가 #rrggbb 형식이 아님 (${String(tok['value'])})`];
  if (role === 'surface') {
    if (isForbiddenSurface(rgb)) out.push(`${label}: 면 토큰이 금지 색 범위(H280–330·L≤35·S≥40) (${String(tok['value'])})`);
    return out;
  }
  if (role !== 'text' && role !== 'nontext') return [...out, `${label}: role이 surface|text|nontext가 아님`];
  const onName = str(tok['on']);
  const onTok = scheme[onName];
  const onRgb = isRecord(onTok) && onTok['role'] === 'surface' ? parseHex(onTok['value']) : undefined;
  if (onRgb === undefined) return [...out, `${label}: on 대상 surface 토큰 없음 (${onName || '(미지정)'})`];
  const min = role === 'text' ? MIN_CONTRAST_TEXT : MIN_CONTRAST_NONTEXT;
  const ratio = contrastRatio(rgb, onRgb);
  if (ratio < min) out.push(`${label}: ${onName} 대비 ${ratio.toFixed(2)} < ${min}`);
  return out;
}

export function checkTokens(tokens: unknown): string[] {
  if (!isRecord(tokens)) return ['tokens: export const tokens 객체가 아님'];
  const out: string[] = [];
  const colors = isRecord(tokens['colors']) ? tokens['colors'] : {};
  for (const name of SCHEMES) {
    const scheme = colors[name];
    if (!isRecord(scheme)) {
      out.push(`colors.${name}: 스킴 없음`);
      continue;
    }
    for (const [key, tok] of Object.entries(scheme)) {
      const label = `colors.${name}.${key}`;
      out.push(...(isRecord(tok) ? checkColor(label, tok, scheme) : [`${label}: 객체가 아님`]));
    }
  }
  for (const group of ['fonts', 'icons'] as const) {
    const list = tokens[group];
    if (!Array.isArray(list)) {
      out.push(`${group}: 배열 없음`);
      continue;
    }
    list.forEach((e: unknown, i) => {
      const label = `${group}[${i}]${isRecord(e) && str(e['name']) ? `(${str(e['name'])})` : ''}`;
      out.push(...(isRecord(e) ? checkProvenance(label, e) : [`${label}: 객체가 아님`]));
    });
  }
  return out;
}

function walk(dir: string, acc: string[]): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(full, acc);
    } else if (ent.isFile() && ASSET_EXT.test(ent.name)) {
      acc.push(full);
    }
  }
  return acc;
}

export function isAllowedAssetPath(rel: string): boolean {
  if (AUDIO_EXT.test(rel)) return false;
  if (rel === 'apps/web/public/favicon.ico') return true;
  if (rel.startsWith('apps/web/public/icons/')) return true;
  if (rel.startsWith('apps/web/public/fonts/')) return /\.woff2$/i.test(rel);
  return rel.startsWith('docs/') || rel.startsWith('qa/manual/');
}

export function checkAssets(root: string): string[] {
  return walk(root, [])
    .map((f) => relative(root, f).split(sep).join('/'))
    .sort()
    .filter((rel) => !isAllowedAssetPath(rel))
    .map((rel) => (AUDIO_EXT.test(rel)
      ? `${rel}: 오디오 파일은 저장소에 둘 수 없음(MVP)`
      : `${rel}: 허용 경로(public/icons·favicon.ico·public/fonts/*.woff2·docs·qa/manual) 밖의 에셋`));
}

/** manifest JSON 파싱 실패는 예외(실행 오류)로 던진다. */
export function checkManifest(root: string): string[] {
  const file = join(root, MANIFEST_REL);
  if (!existsSync(file)) return [];
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isRecord(data)) throw new Error(`${MANIFEST_REL}: JSON 객체가 아님`);
  return (['name', 'short_name'] as const)
    .filter((k) => str(data[k]).toLowerCase().includes(FORBIDDEN_NAME))
    .map((k) => `${MANIFEST_REL}: ${k}에 금지 문자열 포함 (${str(data[k])})`);
}

async function loadTokens(root: string, ctx: RunContext): Promise<string[]> {
  const file = join(root, TOKENS_REL);
  if (!existsSync(file)) {
    ctx.out(`토큰 모듈 미구현 (${TOKENS_REL} 없음) — 토큰 검사 건너뜀`);
    return [];
  }
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  if (!('tokens' in mod)) throw new Error(`${TOKENS_REL}: tokens export 없음`);
  return checkTokens(mod['tokens']);
}

export async function run(argv: readonly string[], ctx: RunContext): Promise<number> {
  const root = parseFlags(argv)['root'] ?? ctx.cwd;
  try {
    if (!existsSync(root) || !statSync(join(root, 'apps/web'), { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`--root가 없거나 apps/web이 없음: ${root}`);
    }
    const violations = [...(await loadTokens(root, ctx)), ...checkAssets(root), ...checkManifest(root)];
    if (violations.length > 0) {
      for (const v of violations) ctx.err(`위반: ${v}`);
      ctx.err(`check:design-tokens 실패 — 위반 ${violations.length}건`);
      return 1;
    }
    ctx.out('check:design-tokens OK');
    return 0;
  } catch (error) {
    ctx.err(`실행 오류: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
