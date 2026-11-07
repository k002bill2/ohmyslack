// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** 서버 도메인 모듈(정본: DEV_DESIGN §2-1). B1: 다른 모듈의 repo는 직접 import하지 않는다. */
const SERVER_MODULES = ['auth', 'conversations', 'messages', 'sync', 'realtime', 'ops'];
/** 웹 기능 폴더(정본: DEV_DESIGN §2-1). B8: 다른 기능은 index.ts 공개 API로만 참조한다. */
const WEB_FEATURES = ['auth', 'sidebar', 'conversation', 'thread', 'sync', 'pwa'];
/** B7: 지속 저장소 전역. 예외 파일은 자기 전역 하나만 허용한다. */
const PERSIST_GLOBALS = ['localStorage', 'sessionStorage', 'indexedDB', 'caches'];
const PERSIST_EXCEPTIONS = {
  'apps/web/src/features/pwa/sw.ts': 'caches',
  'apps/web/src/features/sync/checkpoint.ts': 'localStorage',
};

/** @param {readonly string[]} names */
function persistRules(names) {
  const message = 'B7: 대화 본문·인증 응답을 브라우저 지속 저장소에 넣지 않습니다(DEV_DESIGN §2-2).';
  return {
    'no-restricted-globals': ['error', ...names.map((name) => ({ name, message }))],
    'no-restricted-properties': [
      'error',
      ...['window', 'self', 'globalThis'].flatMap((object) =>
        names.map((property) => ({ object, property, message })),
      ),
    ],
  };
}

/** @param {string} own */
function serverModuleBlock(own) {
  return {
    files: [`apps/server/src/modules/${own}/**/*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: `(?:^|/)(?!${own}/)(?!\\.\\.?/)[^/.][^/]*/repo[^/]*$`,
              message: 'B1: 다른 모듈의 repo 대신 그 모듈의 service를 호출합니다.',
            },
          ],
        },
      ],
    },
  };
}

/** @param {string} own */
function webFeatureBlock(own) {
  const others = WEB_FEATURES.filter((f) => f !== own).join('|');
  return {
    files: [`apps/web/src/features/${own}/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: `(?:^|/)(?:${others})/.+`,
              message: 'B8: 다른 기능 폴더는 index.ts 공개 API(폴더 경로)로만 import합니다.',
            },
          ],
        },
      ],
    },
  };
}

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'reports/**', 'coverage/**', 'dev/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/modules/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(?:^|/)modules/[^/]+/repo[^/]*$',
              message: 'B1: 모듈 밖에서는 repo를 직접 import하지 않습니다.',
            },
          ],
        },
      ],
    },
  },
  ...SERVER_MODULES.map(serverModuleBlock),
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/features/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(?:^|/)features/[^/]+/.+',
              message: 'B8: 기능 폴더는 index.ts 공개 API(폴더 경로)로만 import합니다.',
            },
          ],
        },
      ],
    },
  },
  ...WEB_FEATURES.map(webFeatureBlock),
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: Object.keys(PERSIST_EXCEPTIONS),
    rules: persistRules(PERSIST_GLOBALS),
  },
  ...Object.entries(PERSIST_EXCEPTIONS).map(([file, allowed]) => ({
    files: [file],
    rules: persistRules(PERSIST_GLOBALS.filter((name) => name !== allowed)),
  })),
);
