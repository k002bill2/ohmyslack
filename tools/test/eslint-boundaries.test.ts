import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const eslint = new ESLint({ cwd: REPO });

async function ruleIds(rel: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(REPO, rel) });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'parse-error');
}

describe('eslint boundary rules (DEV_DESIGN §2-2)', () => {
  it('B1: module code may not import another module repo, only its own', async () => {
    const file = 'apps/server/src/modules/messages/service.ts';
    expect(await ruleIds(file, "import { x } from '../conversations/repo.js';\nexport { x };\n"))
      .toContain('no-restricted-imports');
    expect(await ruleIds(file, "import { x } from './repo.js';\nexport { x };\n")).toEqual([]);
    expect(await ruleIds(file, "import { x } from '../conversations/service.js';\nexport { x };\n")).toEqual([]);
    expect(await ruleIds('apps/server/src/app.ts', "import { x } from './modules/auth/repo.js';\nexport { x };\n"))
      .toContain('no-restricted-imports');
  });

  it('B7: persistent storage globals are banned in web src except the two files', async () => {
    const regular = 'apps/web/src/features/conversation/store.ts';
    for (const code of [
      "export const v = localStorage.getItem('k');\n",
      "export const v = window.sessionStorage.length;\n",
      "export const v = indexedDB;\n",
      "export const v = self.caches;\n",
    ]) {
      expect((await ruleIds(regular, code)).some((id) => id.startsWith('no-restricted'))).toBe(true);
    }
    expect(await ruleIds('apps/web/src/features/sync/checkpoint.ts', "export const v = localStorage.getItem('c');\n"))
      .toEqual([]);
    expect(await ruleIds('apps/web/src/features/sync/checkpoint.ts', 'export const v = indexedDB;\n'))
      .toContain('no-restricted-globals');
    expect(await ruleIds('apps/web/src/features/pwa/sw.ts', "export const v = caches.open('shell');\n")).toEqual([]);
    expect(await ruleIds('apps/web/src/features/pwa/sw.ts', "export const v = localStorage;\n"))
      .toContain('no-restricted-globals');
  });

  it('B8: features import each other only through the folder index', async () => {
    const file = 'apps/web/src/features/thread/Panel.tsx';
    expect(await ruleIds(file, "import { a } from '../sync/checkpoint';\nexport { a };\n"))
      .toContain('no-restricted-imports');
    expect(await ruleIds(file, "import { a } from '../sync';\nexport { a };\n")).toEqual([]);
    expect(await ruleIds('apps/web/src/App.tsx', "import { a } from './features/auth/form';\nexport { a };\n"))
      .toContain('no-restricted-imports');
    expect(await ruleIds('apps/web/src/App.tsx', "import { a } from './features/auth';\nexport { a };\n")).toEqual([]);
  });
});
