/**
 * 역할 토큰 → CSS custom properties 문자열(§3-2·§3-3·§3-5).
 * 라이트는 `:root`, 다크는 `@media (prefers-color-scheme: dark)`(§3-3 다크 모드), 모션 축소는 §3-5.
 * 앱 연결(main.tsx import)은 W-10 범위.
 */
import { layoutVars, tokens } from './tokens.js';

type VarMap = Readonly<Record<string, string>>;

function declarations(vars: VarMap, indent: string): string {
  return Object.entries(vars).map(([name, value]) => `${indent}${name}: ${value};`).join('\n');
}

function colorVars(scheme: 'light' | 'dark'): VarMap {
  return Object.fromEntries(Object.entries(tokens.colors[scheme]).map(([name, tok]) => [name, tok.value]));
}

export function buildTokensCss(): string {
  const base: VarMap = {
    ...tokens.typography, ...tokens.space, ...layoutVars, ...tokens.radius, ...tokens.shadow, ...tokens.motion,
    ...colorVars('light'),
  };
  return [
    `:root {\n${declarations(base, '  ')}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root {\n${declarations(colorVars('dark'), '    ')}\n  }\n}`,
    `@media (prefers-reduced-motion: reduce) {\n  :root {\n${declarations(tokens.motionReduced, '    ')}\n  }\n}`,
  ].join('\n') + '\n';
}
