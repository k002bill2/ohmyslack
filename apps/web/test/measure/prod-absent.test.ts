// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MARKER = '__omsLatency';
const temps: string[] = [];

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** 빌드 산출물 전체(청크·sw.js·html)에서 마커가 나온 횟수. envDir은 빈 임시 디렉터리라 .env를 읽지 않는다. */
async function markerCount(probe: boolean): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), 'oms-measure-'));
  temps.push(root);
  const outDir = join(root, 'out');
  const prev = process.env.VITE_LATENCY_PROBE;
  if (probe) process.env.VITE_LATENCY_PROBE = '1';
  else delete process.env.VITE_LATENCY_PROBE;
  try {
    await build({
      configFile: join(WEB, 'vite.config.ts'),
      root: WEB,
      envDir: mkdtempSync(join(root, 'env-')),
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    if (prev === undefined) delete process.env.VITE_LATENCY_PROBE;
    else process.env.VITE_LATENCY_PROBE = prev;
  }
  return filesUnder(outDir).reduce((sum, file) => sum + readFileSync(file, 'utf8').split(MARKER).length - 1, 0);
}

afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('W-10k C 운영 번들에 측정 코드 0', () => {
  it('플래그 없는 운영 빌드에는 __omsLatency가 0건, 측정 빌드에는 1건 이상(양성 대조)', async () => {
    expect(await markerCount(false)).toBe(0);
    expect(await markerCount(true)).toBeGreaterThan(0);
  }, 120_000);
});
