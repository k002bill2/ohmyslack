/**
 * `packages/shared` zod 계약(B5)의 서버 측 진입점. 워크스페이스 패키지는 dist를 가리키지만 verify는
 * build 전에 typecheck·test를 돌리므로 소스를 상대 경로로 직접 읽는다(tsconfig.build.json rootDir 참조).
 */
export * from '../../../packages/shared/src/index.js';
