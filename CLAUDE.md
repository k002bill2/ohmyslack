# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ohmyslack(내부 코드명) — 개인 전용 팀 메신저 웹앱(채널·DM·스레드·멘션·읽음). 단일 Fastify 프로세스(HTTP+WS) + React/Vite PWA + Postgres.
정본 문서: `docs/02-prd/PRD.md`(FR-*), `docs/03-trd/TRD.md`(API·WS 계약), `docs/04-dev-design/DEV_DESIGN.md`(구조·경계 규칙·게이트·WBS), `docs/07-ui-spec/`(UI 상태·카피).
설계 수치·문구는 이 문서들과 상수 모듈이 정본이다 — 코드·테스트 이름에 새로 정하지 않는다(DEV_DESIGN §8-9).

## Commands

Node `26.13.0`(.nvmrc), pnpm `10.30.2`. 모두 저장소 루트에서 실행.

| 목적 | 명령 |
|---|---|
| 전체 PR 게이트(CI와 동일) | `pnpm verify` — install→typecheck→lint→test(coverage)→test:int→build→check:*→audit. `VERIFY_SKIP_INT=1`이면 통합 테스트 생략 |
| 패키지 전체 typecheck/lint/unit test | `pnpm -r typecheck` / `pnpm -r lint` / `pnpm -r test` |
| 통합·프로토콜 E2E (실DB) | `pnpm test:int` — `TEST_DATABASE_URL` 필요(로컬은 `.env.test`), 파일 직렬 실행 |
| 단일 웹 테스트 | `pnpm --filter @ohmyslack/web exec vitest run test/thread/drafts.test.tsx` |
| 단일 서버 단위 테스트 | `pnpm --filter @ohmyslack/server exec vitest run test/auth/password.unit.test.ts` |
| 단일 통합 테스트 | `pnpm exec vitest run --config vitest.int.config.ts apps/server/test/messages/idempotency.int.test.ts` (`TEST_DATABASE_URL` 로드 후) |
| 서버 DB 마이그레이션 | `pnpm --filter @ohmyslack/server migrate [--dry-run]` (루프백 DB만 허용) |
| 빌드 | `pnpm -r build` (웹 산출물 `apps/web/dist`를 서버가 같은 출처로 서빙) |

정적 검사(모두 `pnpm verify`에 포함): `check:cleanroom`, `check:no-persist-cache`, `check:design-tokens`, `check:fr-coverage`, `check:log-leak`.
단계 게이트 전용(PR마다 X): `pnpm e2e:realgap`, `pnpm perf:latency[:smoke]`, `pnpm drill:restore`.

테스트 파일 규칙: 서버 `*.unit.test.ts`(패키지 vitest) / `*.int.test.ts`(루트 int 설정), 웹 `test/**/*.test.tsx`(jsdom, TZ=Asia/Seoul 고정), 프로토콜 E2E `e2e/*.e2e.test.ts`. 커버리지 임계 lines 80%.

## Architecture

pnpm 모노레포 3패키지:
- `packages/shared` — zod 스키마가 API·WS 계약의 **단일 정의**(B5). JSON은 `snake_case`, TS는 `camelCase`, 변환은 shared 스키마 경계에서만. 서버는 `apps/server/src/shared.ts`로 소스를 직접 import(빌드 전 typecheck 때문).
- `apps/server` — Fastify. `src/app.ts`의 `buildApp(options)`가 주입된 store 유무에 따라 라우트를 조건부 등록(테스트는 DB 없이 골격만 띄울 수 있음). `main.ts`는 env(`PORT`, `DATABASE_URL`, `ALLOWED_ORIGIN`, 선택 `WEB_DIST_DIR`, `HOST`)로 Pg store를 연결. 도메인 모듈 `src/modules/{auth,conversations,members,messages,sync,realtime,ops}`는 각각 `routes → service → repo/store` 구조이고 `index.ts`가 공개 API.
- `apps/web` — React 19 + Vite PWA. `src/data/`가 화면 데이터 주입 경계(`createHttpDataSource` = HTTP+WS, `fold.ts`로 이벤트 접기). 기능은 `src/features/<name>/`, 공통 UI·디자인 토큰은 `src/ui/`. Service Worker는 `features/pwa/sw.ts`를 `vite.config.ts`의 커스텀 플러그인이 `/sw.js`로 빌드하고 precache 목록을 주입(workbox 없음). 토큰 CSS는 가상 모듈 `virtual:tokens.css`(CSP `style-src 'self'` 준수).

### 경계 규칙 (DEV_DESIGN §2-2, 위반 시 lint/테스트가 실패)
- **B1** 다른 서버 모듈의 `repo`를 import 금지 — 그 모듈의 service를 호출(eslint).
- **B2** 모든 HTTP 라우트·WS 동작은 `access` 메타(`public|account|admin|conversation|message`) 필수. 대화 단위 접근 판정은 `conversations.service.assertAccess` 하나로만. 레지스트리 테스트가 등록된 전체 라우트를 수집해 검사.
- **B3** realtime은 DB **커밋 후** 서비스가 내는 도메인 이벤트만 팬아웃.
- **B4** WS는 알림 경로, 진실의 원천은 DB. 클라이언트는 전역 숫자 checkpoint + `GET /api/sync`(change_id 기준)로 catch-up, 410이면 snapshot 재초기화.
- **B6** 로그는 `ops` 로거만(허용 필드 외 제거). 본문·토큰·쿠키·ID 로깅 금지(`check:log-leak` 카나리아).
- **B7** 웹은 대화 본문·인증 응답을 localStorage/sessionStorage/IndexedDB/Cache Storage에 저장 금지. 예외: `features/pwa/sw.ts`(셸 정적 자원), `features/sync/checkpoint.ts`(숫자 checkpoint만).
- **B8** 웹 기능 폴더끼리는 폴더 경로(`index.ts`)로만 import.

메시지 전송 흐름·멱등성(같은 `client_message_id` 재시도=원결과, 다른 payload=409)·읽음 병합(`max`) 등 세부는 DEV_DESIGN §2-3.

## 진행 방식 (영환님 지시, 2026-11-11 — 세션·레인이 바뀌어도 유지)

- 선택지가 생기면 추천안(★)을 골라 **묻지 않고 바로 진행**한다. "어느 안으로 할까요?"·"★로 진행할까요?" 같은 확인 질문을 하지 않는다. 결과 보고에 `선택: ★<안>(사유 한 줄)`만 남긴다.
- 단계가 끝나면 「다음 진행해」를 기다리지 않고 다음 단계로 이어간다. 병합·의존성 추가·정리·후속 레인도 포함하며, 백업·브랜치 같은 안전조치를 먼저 하고 사후 보고한다.
- 멈추고 묻는 경우는 다음뿐이다: ① push·PR 생성 등 원격 쓰기, ② 승인 상한을 넘는 유료 사용, ③ 아래 Hard constraints가 사람에게 맡긴 작업(운영 DB·`.env`·운영 계정), ④ 되돌릴 수 없는 삭제(DB·볼륨·백업), ⑤ 추천안을 정할 근거가 없을 때. ⑤도 한 번에 묻고 번호 선택지에 ★를 붙인다.

## Hard constraints

- **클린룸**(`CLEANROOM.md`): Slack 코드·에셋·스크린샷·시그니처 색·사운드·폰트 사용 금지. 금지 문자열 목록을 다른 파일에 복제하지 않는다. 기능 추가 커밋/PR 본문에 `참고 출처: <공개 문서 또는 '일반 관념'>` 한 줄. 디자인 토큰은 `docs/05-design-ref/DESIGN_REFERENCE.md`의 오픈 출처만.
- 서버는 `127.0.0.1`에만 바인드(`bind.ts`가 그 외 거부). Tailscale Funnel 금지. Redis·브로커·마이크로서비스 도입 금지.
- `.env` 값(운영 `DATABASE_URL`)을 읽거나 출력·기록하지 않는다. 운영 DB에서 테스트·마이그레이션 실험 금지. 운영 계정 작업은 사람이 `docs/runbooks/`대로 직접 한다.
- 브라우저 확인은 ego-browser로만. Playwright·Puppeteer 설치 금지.
- 수동 QA(`qa/manual/QA-*.md`)는 실제 실행 없이 PASS 표시 금지.
