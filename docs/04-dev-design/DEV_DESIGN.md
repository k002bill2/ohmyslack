상태: R1 초안 / 작성자: Claude-Opus 5.5 (pubkey `7484092c…`) / 입력: `docs/00-research/BUZZ_ROUND2_DOCS.md` 0–5절, `docs/02-prd/PRD.md`(GPT-Sol R1, v1.1), `docs/_drafts/PRD-jarvis-v0.md`, `docs/01-synthesis/DISCUSSION_SYNTHESIS.md`, `docs/00-research/buzz/{GPT-Luna,GPT-Sol,Claude-Opus}.md`, `CLEANROOM.md`, `~/.hermes/profiles/{developer,designer,qa,security}/SOUL.md`(역할 계약), `~/Work/shared-infra/README.md`(PostgreSQL 15·`backup.sh`)

# 개발설계서 — ohmyslack (내부 코드명)

- 최종 채택: 영환님. 이 문서는 개발 방법의 제안입니다. 코드 작성·설치·Git·DB 접속·테스트 실행은 하지 않았습니다.
- 작성 시점에 TRD(`docs/03-trd/TRD.md`)와 디자인 레퍼런스(`docs/05-design-ref/DESIGN_REFERENCE.md`)는 아직 없었습니다. 그래서 테이블명·API·WS 이벤트명·컴포넌트명은 **가정**으로 표시하고 R3에서 맞춥니다(10절).

## 0. 용어 — "P0"가 두 가지 뜻입니다

| 표기 | 뜻 | 정의한 곳 |
|---|---|---|
| **단계 P0–P4** | 개발 단계(준비 → MVP → v1 → Electron → export 가져오기) | 브리프 0절, 이 문서 3절 |
| **우선순위 P0/P1/P2** | FR의 기능 우선순위(P0 = MVP 필수) | PRD 7절, PRD 11절 가정 5 |

**우선순위 P0 FR은 단계 P1(MVP)에서 출시합니다.** 이 문서에서 단계는 항상 "단계 P1"처럼, 우선순위는 "P0 FR"처럼 씁니다. 게이트는 `G0–G4`(단계 종료 게이트)로 따로 부릅니다.

## 1. 결론

1. **구조:** pnpm 모노레포 `apps/web`(React+Vite PWA)·`apps/server`(Fastify HTTP+WS 단일 프로세스)·`packages/shared`(zod 계약)의 3개 패키지로 시작합니다. 서버는 도메인 모듈 6개(auth·conversations·messages·sync·realtime·ops)로 나눕니다. 접근 검사는 `conversations` 모듈의 함수 하나로만 통과하게 합니다.
2. **진행:** 단계 P1은 세로 slice 6개로 나눠 TDD로 쌓습니다. G1은 PRD의 P0 FR 33개 모두에 대해 지정 테스트가 통과해야 열립니다. FR→테스트 매핑(6절)은 테스트 이름에 FR ID를 넣고, `check:fr-coverage` 스크립트로 기계 검증합니다.
3. **먼저 정해 주셔야 할 것(⚖️, 9절):** ① 통합 테스트용 별도 DB(`ohmyslack_test`, shared-infra 변경) ② Playwright·Puppeteer 금지 규칙에 따른 UI E2E 공백을 수동 QA(ego-browser·실기기)로 메울지 ③ CI를 GitHub Actions로 돌릴지, 로컬 게이트만 둘지

## 2. 모노레포 구조

### 2-1. 디렉터리 (가정: 패키지 관리자 pnpm 10.30.2, 워크스페이스)

```text
ohmyslack/
├─ apps/
│  ├─ server/                 # Fastify: HTTP API + WebSocket, 단일 프로세스
│  │  ├─ src/
│  │  │  ├─ modules/
│  │  │  │  ├─ auth/          # 초대·로그인·세션·비활성화·출처 검증·로그인 제한
│  │  │  │  ├─ conversations/ # 채널·DM·멤버십·접근 검사(유일 진입점)
│  │  │  │  ├─ messages/      # 전송(멱등·seq)·이력·수정/삭제·스레드·멘션
│  │  │  │  ├─ sync/          # 읽음 커서·unread 집계·변경 커서 따라잡기
│  │  │  │  ├─ realtime/      # WS 게이트웨이·구독·팬아웃(메모리)
│  │  │  │  └─ ops/           # health·로그 마스킹·계측 허용 목록
│  │  │  ├─ db/               # 연결 풀·트랜잭션 헬퍼(쿼리 계층은 TRD 결정)
│  │  │  ├─ app.ts            # 플러그인 등록·라우트 조립
│  │  │  └─ main.ts           # 127.0.0.1 바인드·기동
│  │  ├─ migrations/          # 순서형 SQL: NNNN_<설명>.sql (DDL은 TRD)
│  │  └─ test/                # *.int.test.ts (실DB) / *.unit.test.ts
│  └─ web/                    # React + TypeScript + Vite, PWA
│     ├─ src/
│     │  ├─ features/
│     │  │  ├─ auth/  ├─ sidebar/  ├─ conversation/   # 타임라인·작성기
│     │  │  ├─ thread/  ├─ sync/   # WS 클라이언트·따라잡기·가시성 복귀
│     │  │  └─ pwa/                 # manifest·SW 등록·설치 안내
│     │  ├─ ui/               # 디자인 토큰·공통 컴포넌트(DESIGN_REFERENCE 기준)
│     │  └─ main.tsx
│     ├─ public/              # manifest.webmanifest·자체 제작 아이콘
│     └─ test/                # *.test.tsx (컴포넌트·로직)
├─ packages/
│  └─ shared/                 # zod 스키마: API DTO·WS 이벤트·오류 코드·ID 타입
├─ e2e/                       # 프로토콜 E2E: Node 클라이언트 2–3개로 다기기 모사(브라우저 없음)
├─ perf/                      # FR-SYNC-01 부하 스크립트(단계 게이트 전용)
├─ qa/
│  └─ manual/                 # 수동 체크리스트: QA-<FR ID>.md (실기기·ego-browser)
├─ tools/                     # check-cleanroom·check-fr-coverage·check-log-leak·restore-drill
└─ docs/
```

- **패키지는 3개만 둡니다(YAGNI).** DB 계층을 별도 패키지로 빼지 않습니다. 서버만 DB를 씁니다. 공용 설정(tsconfig·eslint)은 루트 파일로 둡니다.
- **파일 크기:** 함수 50줄·파일 800줄·중첩 4단계 이내, 파일 200–400줄 권장(영환님 전역 규칙).

### 2-2. 모듈 경계 규칙

| # | 규칙 | 이유 | 기계 검증 |
|---|---|---|---|
| B1 | 서버 모듈은 `routes → service → repo` 한 방향만 호출합니다. 다른 모듈의 `repo`를 직접 부르지 않고, 그 모듈의 `service`만 부릅니다. | 접근 검사 우회 경로 차단 | eslint `no-restricted-imports`(`**/modules/*/repo*`는 같은 모듈에서만) |
| B2 | 대화 단위 접근 검사는 `conversations.service.assertAccess(userId, conversationId, action)` **하나**로만 합니다. HTTP·이력·전송·수정·삭제·스레드·읽음 갱신·WS 구독이 모두 이 함수를 거칩니다. | FR-CONV-04 | 라우트 레지스트리 테스트(6절 FR-CONV-04): `:conversationId`를 가진 모든 라우트와 WS 구독이 매트릭스에 들어 있어야 통과 |
| B3 | `realtime`은 DB 커밋 **후** 서비스가 내는 도메인 이벤트만 구독합니다. 커밋 전 전송은 금지입니다. | FR-MSG-02(커밋 후 저장 확인) | 통합 테스트: 롤백된 트랜잭션은 WS 이벤트 0건 |
| B4 | WS는 알림 경로이고 진실의 원천은 DB입니다. 클라이언트는 재접속·전경 복귀 때마다 서버 커서로 따라잡습니다. | FR-SYNC-02/07 | E2E: 이벤트를 고의로 유실시켜도 수렴 |
| B5 | `packages/shared`의 zod 스키마가 API·WS 계약의 단일 정의입니다. 서버는 입력을 경계에서 검증하고, 웹은 수신 이벤트를 같은 스키마로 파싱합니다. | 경계 입력 검증, 계약 드리프트 방지 | `tsc --noEmit` 전 패키지 |
| B6 | 로그는 `ops` 모듈의 로거만 씁니다. 로거는 허용 필드 목록 밖의 값을 버립니다(PRD 10절). 본문·자격 증명·토큰·쿠키는 직렬화 단계에서 제거합니다. | FR-OPS-03 | 카나리아 문자열 로그 grep(6절) |
| B7 | 웹은 대화 본문을 Cache Storage·IndexedDB·localStorage에 넣지 않습니다. SW는 앱 셸 정적 자원만 캐시하고 `/api`·WS는 우회합니다. | FR-CLIENT-04 | SW 라우팅 단위 테스트 + 수동 점검 |
| B8 | 웹 기능 폴더끼리는 `index.ts` 공개 API로만 참조합니다. | 결합도 제한 | eslint import 규칙 |

### 2-3. 요청 흐름 (가정 — 이름은 TRD에서 확정)

1. 전송: `POST /api/conversations/:id/messages {client_message_id, body, thread_root_id?}` → `assertAccess` → 트랜잭션(대화 행 `last_seq` 증가 → `messages` insert, `(conversation, author, client_message_id)` 유일) → 커밋 → 응답 `{message_id, seq}` → 커밋 후 `message.created`를 참여자의 연결된 기기에 팬아웃합니다(본인 다른 기기 포함, PRD 가정 3).
2. 따라잡기: 클라이언트가 보관한 **변경 커서**로 `GET /api/sync?since=<cursor>`를 호출합니다. 본문 순서용 `seq`와 수정·삭제·읽음을 담는 변경 커서는 구분합니다(PRD 11절 가정 2). 커서가 만료됐거나 서버를 복원한 경우는 전체 재동기화합니다.
3. 읽음: `PUT /api/read-state {conversation_id, thread_root_id?, last_read_seq}` → 서버가 `max(기존, 요청)`으로만 갱신합니다(FR-SYNC-06) → `read.updated`를 같은 사용자의 다른 기기에 팬아웃합니다(FR-SYNC-04).

## 3. 단계(P0–P4)와 종료 게이트

일정은 달력으로 제시하지 않습니다(합본 4절 정정 4). 각 WBS 항목에 상대 크기 S/M/L만 붙입니다.

| 단계 | 목표 | 종료 게이트 | 게이트 판정자 |
|---|---|---|---|
| **P0 준비** | 문서 4종 R3 채택, 저장소 골격·CI, 테스트 DB 결정 | **G0**: ① PRD·TRD·개발설계서·디자인 레퍼런스 R3 최종안을 영환님이 채택 ② P0 FR ID 동결(이후 변경은 PRD 변경 이력 + 6절 표 동시 수정) ③ 빈 골격에서 `pnpm verify`(5절) 통과 ④ 9절 ⚖️-1·2·3 결정 | 영환님(Jarvis 정리) |
| **P1 MVP** | P0 FR 33개 전부 | **G1**: ① 6절 표의 P0 FR 33개 모두 지정 테스트 통과(PR 게이트 항목은 CI, 단계 게이트 항목은 QA 보고서 증거) ② 커버리지 80% 이상 ③ Security 리뷰 미해결 Critical·High 0건 ④ FR-SYNC-01 부하 결과 기록 ⑤ FR-OPS-02 격리 복원 대조 통과 ⑥ FR-OPS-01 노출 경계 점검 통과 ⑦ PRD 9절 파일럿 3개 업무일, 누출·유실·중복 0건 | QA(검증) → Jarvis → 영환님 |
| **P2 v1** | P1 FR(기기 세션 목록·비공개 채널·파일·검색·presence·Web Push) 중 영환님이 고른 것 | **G2**: 선택한 P1 FR의 테스트 매핑 추가·통과, 검색·파일은 권한 밖 결과 0건, G1 회귀 0건 | 동일 |
| **P3 Electron** | 웹 앱을 감싸는 데스크톱 셸 | **G3**: Electron 공식 보안 문서 기준 설정 확인 — `contextIsolation`·`sandbox` 켜짐, `nodeIntegration` 꺼짐, fuse `RunAsNode`·`EnableNodeOptionsEnvironmentVariable`·`EnableNodeCliInspectArguments` 꺼짐, `EnableEmbeddedAsarIntegrityValidation`·`OnlyLoadAppFromAsar` 켜짐. 확인은 **우리 패키지에만** REA `inspect_electron_fuses`로 합니다(CLEANROOM 6절). 우리 패키지 대상 CLEANROOM 5절 검사 0건 | 동일 + Security |
| **P4 선택** | 공식 export 파일 1회 가져오기 | **G4**: 별도 승인(약관 확인 포함) 뒤에만 착수합니다. 실시간 브리지·Slack API는 대상이 아닙니다 | 영환님 |

- fuse 이름은 Electron 공식 fuses 문서 표기를 따른다고 가정했습니다. 단계 P3 착수 때 그 시점 문서로 다시 확인합니다(확인 필요).

## 4. WBS — 단계 P0·P1

역할은 Hermes 실행 역할 기준입니다. **결과는 모든 역할이 Jarvis에게만 반환합니다.** 역할 간 전달(Designer→Developer, Developer→Security·QA)도 Jarvis를 거칩니다. Git commit·push는 Jarvis 규칙을 따릅니다(브리프 1절: push는 Jarvis만).

- **Developer:** 구현과 **모든 자동 테스트 작성**(TDD)을 맡습니다.
- **QA:** 읽기 전용 독립 검증만 합니다. 테스트를 쓰지 않고, 실행·재현·수동 체크리스트 수행·보고를 합니다.
- **Security(Orca):** 위협 모델·설계/코드 리뷰를 합니다. 인프라·설정을 직접 바꾸지 않습니다.
- **Designer:** 디자인 레퍼런스를 화면·컴포넌트·상태 명세로 바꿔 handoff합니다.

| ID | 작업 | 역할 | 선행 | 완료 조건 | FR | 크기 |
|---|---|---|---|---|---|---|
| W-01 | 모노레포 골격·tsconfig·eslint·vitest·`pnpm verify` | Developer | G0 ①② | 빈 골격에서 5절 명령 전부 exit 0 | — | S |
| W-02 | 품질 스크립트 4종: `check:cleanroom`(CLEANROOM 5절 그대로 호출)·`check:fr-coverage`·`check:log-leak`·`check:no-persist-cache` | Developer | W-01 | 각 스크립트의 실패 사례를 일부러 만들어 exit 1 확인(Red) 후 원복해 exit 0 | OPS-04, OPS-03, CLIENT-04 | S |
| W-03 | 위협 모델(자산·신뢰 경계: tailnet·Serve·쿠키·WS·SW) | Security | TRD R3 | TR-SEC 항목별 대응 테스트 후보 목록을 Jarvis에 반환 | AUTH-06, OPS-01 | S |
| W-04 | 화면·컴포넌트 상태 명세(3단·모바일 1단·전송 상태·오프라인·포커스 순서) | Designer | DESIGN_REFERENCE R3 | 컴포넌트별 상태표·키보드 순서·브레이크포인트·클린룸 출처 표기 | CLIENT-01/02/07, MSG-02 | M |
| W-05 | 마이그레이션 0001: 사용자·세션·초대·대화·멤버십·메시지·읽음·변경 로그 | Developer | TRD DDL, ⚖️-1 | 빈 테스트 DB에 적용·되돌림 없이 재적용 멱등. 실DB(`ohmyslack`) 미사용 | (기반) | M |
| W-06 | **Slice A — 인증:** 첫 관리자 생성(로컬 절차)·초대·로그인·로그아웃·비활성화·관리자 가드·출처 검증·로그인 제한 | Developer | W-05 | 6절 AUTH-01·02·03·05·06 테스트 통과 | AUTH-* | L |
| W-07 | **Slice B — 대화 공간:** 채널 생성·목록·참여·나가기, DM 시작, `assertAccess` | Developer | W-06 | CONV-01–04 통과, 라우트 레지스트리 매트릭스 통과 | CONV-* | M |
| W-08 | **Slice C — 메시지:** 멱등 전송·seq·이력 페이지·수정/삭제·스레드·멘션·안전 렌더 | Developer | W-07 | MSG-01·03–07 통과 | MSG-* | L |
| W-09 | **Slice D — 실시간·동기화:** WS 게이트웨이·팬아웃·변경 커서 따라잡기·읽음 커서 병합·unread 집계 | Developer | W-08 | SYNC-02–06 통과, B3·B4 테스트 통과 | SYNC-* | L |
| W-10 | **Slice E — 웹 UI:** 3단/1단 레이아웃·작성기(IME·전송 상태)·스레드 패널·키보드·접근성 | Developer | W-04, W-09 | MSG-02·08, CLIENT-01·02·07 컴포넌트 테스트 통과 | CLIENT-*, MSG-02/08 | L |
| W-11 | **Slice F — PWA·모바일 재개:** manifest·아이콘·SW(앱 셸만)·가시성 복귀 동기화·연결 상태 표시 | Developer | W-10 | CLIENT-03·04, SYNC-07 자동 테스트 통과 | CLIENT-03/04, SYNC-07 | M |
| W-12 | Tailscale Serve 노출 런북(127.0.0.1 바인드·Serve HTTPS·Funnel 금지)·맥 상시 구동 방식 문서화 | Developer(문서)·Security(검토) | W-06, ⚖️-5 | 런북 + Security 검토 의견. 실제 Serve 설정 변경은 영환님 승인 후 | OPS-01 | S |
| W-13 | 백업·격리 복원 드릴 스크립트(공용 `backup.sh` 무수정, 복원 대상은 승인된 임시 DB) | Developer | W-09, ⚖️-4 | 합성 데이터로 대조 항목 일치 | OPS-02 | M |
| W-14 | 부하 스크립트(20연결·5msg/s·10분, 동일 시계 측정) | Developer | W-09 | p50/p95·실패율·환경 기록 형식 확정 | SYNC-01 | S |
| W-15 | Security 리뷰: 인증·세션·CSRF·WS Origin·IDOR·XSS·로그 누출 | Security | W-06–W-11 | Critical/High 0건 또는 Jarvis에 수정 지시 반환 | AUTH-06, CONV-04, MSG-01, OPS-03 | M |
| W-16 | QA 독립 검증: 자동 테스트 재실행 + `qa/manual` 체크리스트 수행(맥 Safari/Chrome, 다른 맥, iPhone Safari·PWA) | QA | W-11–W-15 | FR별 증거(명령 출력·스크린샷·기기/버전) 보고서. 실행하지 않은 항목은 "미검증"으로 표시 | 6절 전체 | M |
| W-17 | 파일럿 3개 업무일(PRD 9절) | 영환님·QA 기록 | W-16 통과 | 누출·유실·중복 0건, 실패 사례 기록 | S1–S6 | — |

- **Slice 순서의 이유:** 인증 → 접근 검사 → 메시지 → 동기화 → UI입니다. 보안 경계(FR-CONV-04)가 메시지 기능보다 먼저 서야, 이후 추가하는 모든 라우트가 처음부터 매트릭스 테스트에 걸립니다.
- **Slice 완료 정의(PR 단위):** ① 해당 FR 테스트를 먼저 쓰고 실패(Red)를 확인 ② 구현해 통과(Green) ③ `pnpm verify` 통과 ④ 구현자 외 리뷰(QA 또는 Security) 1회 ⑤ PR 본문에 "참고 출처: <공개 문서 또는 '일반 관념'>" 1줄(CLEANROOM 4절).

## 5. 품질 게이트·CI 명령

### 5-1. PR 게이트 — `pnpm verify` (로컬·CI 동일)

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck            # tsc --noEmit, 전 패키지
pnpm -r lint                 # eslint (모듈 경계 규칙 B1·B8 포함)
pnpm -r test -- --coverage   # vitest: unit + 컴포넌트, 커버리지 80% 미만이면 실패
pnpm test:int                # 서버 통합 + e2e/ 프로토콜 E2E, TEST_DATABASE_URL 필요
pnpm -r build
pnpm check:cleanroom         # CLEANROOM.md 5절 명령을 그대로 실행, 0건이어야 통과
pnpm check:fr-coverage       # PRD P0 FR ID가 테스트 이름 또는 qa/manual에 모두 있어야 통과
pnpm check:log-leak          # test:int 로그에서 카나리아 문자열 0건
pnpm audit --prod --audit-level=high
```

- **테스트 DB 안전장치:** `test:int`는 `TEST_DATABASE_URL`의 DB 이름이 `_test`로 끝나지 않으면 즉시 실패합니다. 운영 DB `ohmyslack`에는 절대 접속하지 않습니다. 실행마다 스키마를 비우고 마이그레이션을 다시 적용합니다.
- **`check:fr-coverage` 동작:** `docs/02-prd/PRD.md`에서 우선순위 열이 `P0`인 행의 `FR-XXX-nn`을 추출합니다(작성 시점 33개). 그 ID가 `apps/**/test`·`e2e/`·`perf/`의 테스트 이름이나 `qa/manual/QA-<ID>.md`에 하나라도 없으면 실패합니다. 스캐너 오류도 실패로 처리합니다(PRD FR-OPS-04 수용 기준).
- **CLEANROOM 금지 문자열을 이 문서나 스크립트 본문에 다시 적지 않습니다.** 스크립트는 `CLEANROOM.md` 5절 블록을 읽어 실행합니다. 패턴을 복제하면 문서 자체가 검사에 걸리고, 두 곳이 어긋날 수 있습니다.

### 5-2. CI (가정 — ⚖️-3)

- GitHub Actions(비공개 저장소 `k002bill2/ohmyslack`) 1개 job: Node는 TRD가 고정한 버전, PostgreSQL 서비스 컨테이너는 **15**(shared-infra와 같게)입니다. `pnpm verify`만 실행합니다.
- 비공개 저장소의 Actions 사용량·과금 조건은 확인하지 않았습니다(확인 필요). Actions를 쓰지 않으면 같은 `pnpm verify`를 로컬 pre-push 게이트로 두고, QA가 W-16에서 깨끗한 체크아웃으로 다시 실행합니다.

### 5-3. 단계 게이트 전용 (PR마다 돌리지 않음)

| 명령/절차 | FR | 이유 |
|---|---|---|
| `pnpm perf:latency` (10분) | SYNC-01 | 시간이 길고 환경 의존 |
| `pnpm e2e:realgap` (실제 60초 단절 1회) | SYNC-02 | PR 게이트에서는 시간을 압축한 버전만 돌립니다 |
| `tools/restore-drill.sh` | OPS-02 | 임시 DB 생성이 shared-infra 작업이라 승인 필요 |
| `qa/manual/QA-*.md` | 6절 "수동" 표기 행 | 실기기·실네트워크 필요 |

## 6. 테스트 전략(TDD)과 P0 FR → 테스트 1:1 매핑

### 6-1. 계층

| 계층 | 도구(가정) | 대상 | 위치 |
|---|---|---|---|
| 단위 | vitest | 순수 로직: seq·커서 병합·멘션 파싱·렌더 정화·unread 계산 | `*.unit.test.ts` |
| 통합 | vitest + Fastify `inject` + 실제 PostgreSQL 15 테스트 DB + Node WS 클라이언트 | 라우트·트랜잭션·권한·WS 이벤트 | `apps/server/test/**/*.int.test.ts` |
| 프로토콜 E2E | vitest + 서버 실기동 + Node HTTP/WS 클라이언트 2–3개(기기 A·B, 비참여자 C 모사) | 다기기·재접속·수렴 | `e2e/*.e2e.test.ts` |
| 컴포넌트 | vitest + Testing Library + jsdom | 작성기·IME 이벤트·키보드·상태 표시·SW 라우팅 | `apps/web/test/**/*.test.tsx` |
| 부하 | Node 스크립트 | p95 측정 | `perf/` |
| 수동 | ego-browser(데스크톱 브라우저)·실기기(iPhone Safari/PWA) | 레이아웃·IME 실기·설치·네트워크 경계 | `qa/manual/QA-<FR>.md` |

- **브라우저 자동 E2E는 두지 않습니다.** 영환님 전역 규칙이 Playwright·Puppeteer의 저장소 도입을 금지합니다. 이 공백은 프로토콜 E2E(서버 계약)와 컴포넌트 테스트(UI 로직), 그리고 QA의 ego-browser·실기기 체크리스트로 메웁니다. 브라우저 자동화 수준은 ⚖️-2에서 결정합니다.
- **jsdom의 한계:** 레이아웃 계산·실제 IME·SW 설치는 재현하지 못합니다. 그래서 FR-MSG-08·CLIENT-02·CLIENT-03은 자동 테스트(이벤트·상태 로직)와 수동 체크(실기기)를 **둘 다** 통과해야 합니다.
- **Red-Green 규칙:** 버그 수정은 회귀 테스트로 ① 통과 ② 수정을 되돌려 실패 ③ 복원해 통과를 확인합니다(영환님 검증 규칙).
- **테스트 이름 규칙:** `FR-XXX-nn <수용 기준 요약>`. 한 FR에 보조 테스트를 더 둘 수 있습니다. 다만 아래 표의 **지정 테스트**가 그 FR의 판정 기준입니다.

### 6-2. 매핑 표 — PRD v1.1 P0 FR 33개

"실행" 열: **PR** = 5-1 PR 게이트, **G1** = 단계 게이트(5-3). "수동" 열이 있는 행은 자동 테스트와 수동 체크를 둘 다 통과해야 합니다. 파일 경로는 가정입니다.

| FR | 지정 테스트 이름 | 계층·파일 | 실행 | 수동 |
|---|---|---|---|---|
| FR-AUTH-01 | `FR-AUTH-01 미가입자는 조회·구독이 거부되고, 만료·사용 완료 초대 링크는 거부되며, 동시 사용은 1회만 성공한다` | 통합 `server/test/auth/invite.int.test.ts` | PR | — |
| FR-AUTH-02 | `FR-AUTH-02 로그아웃한 세션은 HTTP가 거부되고 WS가 5초 안에 닫히며 같은 계정의 다른 기기 세션은 유지된다` | 통합 `server/test/auth/session.int.test.ts` | PR | — |
| FR-AUTH-03 | `FR-AUTH-03 비활성화 후 5초 안에 열린 WS가 닫히고 이후 요청은 401이다` | 통합 `server/test/auth/deactivate.int.test.ts` | PR | — |
| FR-AUTH-05 | `FR-AUTH-05 일반 멤버의 초대·비활성화·채널 생성 요청은 403이고 DB 상태가 바뀌지 않는다` | 통합 `server/test/auth/admin-guard.int.test.ts` | PR | — |
| FR-AUTH-06 | `FR-AUTH-06 미인증 HTTP·WS와 외부 Origin의 상태 변경·WS 연결이 거부되고, 로그인 제한 초과 후 정상 사용자가 복구된다` | 통합 `server/test/auth/origin-ratelimit.int.test.ts` | PR | — |
| FR-CONV-01 | `FR-CONV-01 관리자만 공개 채널을 만들고 앞뒤 공백을 제거한 같은 이름은 거부된다` | 통합 `server/test/conversations/channels.int.test.ts` | PR | — |
| FR-CONV-02 | `FR-CONV-02 채널을 나가면 이력·쓰기·구독이 거부되고 5초 안에 기존 구독이 중단되며 재참여할 수 있다` | 통합 `server/test/conversations/membership.int.test.ts` | PR | — |
| FR-CONV-03 | `FR-CONV-03 같은 멤버 쌍의 DM 시작은 순서·동시 요청과 무관하게 같은 DM ID를 반환한다` | 통합 `server/test/conversations/dm.int.test.ts` | PR | — |
| FR-CONV-04 | `FR-CONV-04 비참여자는 대화 단위 모든 라우트와 WS 구독에서 내용·멤버십·이벤트 0건이고 데이터가 바뀌지 않는다` | 통합 `server/test/conversations/access-matrix.int.test.ts`(라우트 레지스트리에서 대상을 자동 수집, 누락 시 실패) | PR | — |
| FR-MSG-01 | `FR-MSG-01 한글·줄바꿈·링크·코드 블록은 표시되고 스크립트·위험 링크 스킴은 무력화되며 빈 메시지·상한 초과는 저장되지 않는다` | 컴포넌트 `web/test/conversation/render.test.tsx` + 통합(저장 거부) | PR | — |
| FR-MSG-02 | `FR-MSG-02 DB 커밋 응답 전에는 저장 확인을 표시하지 않고 오프라인·실패 시 재시도를 표시하며 자동 전송 큐를 만들지 않는다` | 컴포넌트 `web/test/conversation/send-status.test.tsx` | PR | — |
| FR-MSG-03 | `FR-MSG-03 ACK 유실 후 같은 client_message_id·내용 3회는 메시지 1개, 다른 내용은 충돌, 다른 계정·대화와 결합되지 않는다` | 통합 `server/test/messages/idempotency.int.test.ts` | PR | — |
| FR-MSG-04 | `FR-MSG-04 합성 1만 건을 동시 전송 중 seq 커서로 넘기면 페이지 경계 누락·중복이 0이고 재시도는 새 seq를 소비하지 않는다` | 통합 `server/test/messages/paging.int.test.ts` | PR | — |
| FR-MSG-05 | `FR-MSG-05 본인만 수정·삭제하고 타인은 403이며 삭제 본문·멘션은 조회·복구 응답에서 제거되고 답글은 남는다` | 통합 `server/test/messages/edit-delete.int.test.ts` | PR | — |
| FR-MSG-06 | `FR-MSG-06 답글의 답글은 거부되고 원문 삭제 후에도 답글이 남으며 답글 수는 살아 있는 답글만 센다` | 통합 `server/test/messages/thread.int.test.ts` | PR | — |
| FR-MSG-07 | `FR-MSG-07 멘션은 참여자 ID만 1회 집계되고 자기 멘션은 제외되며 수정 시 추가·제거되고 읽음으로 해제된다` | 통합 `server/test/messages/mention.int.test.ts` | PR | — |
| FR-MSG-08 | `FR-MSG-08 IME 조합 중 Enter는 전송하지 않고 확정 후 Enter는 1회 전송하며 Shift+Enter는 줄바꿈이다` | 컴포넌트 `web/test/conversation/composer-ime.test.tsx`(`isComposing`·keyCode 229 이벤트) | PR | `QA-FR-MSG-08`: macOS Safari·Chrome, iOS Safari 한글 실기 |
| FR-SYNC-01 | `FR-SYNC-01 20연결·5msg/s·10분에서 DB 저장→다른 기기 표시 p95 ≤ 1000ms이고 오류율·환경이 기록된다` | 부하 `perf/latency.perf.ts` | G1 | — |
| FR-SYNC-02 | `FR-SYNC-02 단절 중 100건 생성과 기존 메시지 수정·삭제 후 복귀하면 최종 본문·삭제·순서가 같고 누락·중복 0이며 실시간 수신과 경합해도 같다` | 프로토콜 E2E `e2e/reconnect.e2e.test.ts`(단절 시간 압축) | PR + G1 | G1에서 실제 60초 단절 1회(`pnpm e2e:realgap`) |
| FR-SYNC-03 | `FR-SYNC-03 본문·스레드 읽음 위치가 따로 저장되고 본문 열기만으로 답글이 읽음 처리되지 않으며 다른 기기에서 같다` | 통합 `server/test/sync/read-state.int.test.ts` | PR | — |
| FR-SYNC-04 | `FR-SYNC-04 기기 A가 읽음을 저장하면 같은 계정 기기 B에 2초 안에 read.updated가 도착해 배지가 일치한다` | 프로토콜 E2E `e2e/multi-device-read.e2e.test.ts` | PR | — |
| FR-SYNC-05 | `FR-SYNC-05 자기 메시지·삭제 메시지·자기 멘션은 unread·멘션 집계에서 제외되고 재수신해도 중복 집계되지 않는다` | 통합 `server/test/sync/unread-count.int.test.ts` | PR | — |
| FR-SYNC-06 | `FR-SYNC-06 오래된 읽음 위치가 늦게 도착해도 커서가 후퇴하지 않고 최대 유효 위치로 수렴한다` | 통합 `server/test/sync/read-merge.int.test.ts` | PR | — |
| FR-SYNC-07 | `FR-SYNC-07 전경 복귀 시 재연결·커서 확인 후 100건과 수정·삭제·읽음을 반영하고 서버 불가 시 연결 끊김을 표시한다` | 프로토콜 E2E `e2e/resume.e2e.test.ts` + 컴포넌트(가시성 복귀·끊김 표시) | PR | `QA-FR-SYNC-07`: iPhone PWA 5분 백그라운드 후 복귀 |
| FR-CLIENT-01 | `FR-CLIENT-01 키보드만으로 공간 전환·전송·스레드 닫기를 하고 포커스가 원래 항목으로 돌아온다` | 컴포넌트 `web/test/layout/keyboard.test.tsx` | PR | `QA-FR-CLIENT-01`: 데스크톱 3단 실화면(ego-browser) |
| FR-CLIENT-02 | `FR-CLIENT-02 640px 이하에서 공간→본문→스레드→뒤로 1단 내비게이션으로 전환된다` | 컴포넌트 `web/test/layout/responsive.test.tsx`(matchMedia 상태) | PR | `QA-FR-CLIENT-02`: 320·390·640px 가로 넘침, iPhone 390px S2·S4·S6, 가상 키보드 가림 |
| FR-CLIENT-03 | `FR-CLIENT-03 manifest가 standalone·필수 아이콘·start_url을 갖고 일반 웹 접근과 설치 안내가 동작한다` | 단위 `web/test/pwa/manifest.test.ts` | PR | `QA-FR-CLIENT-03`: tailnet HTTPS에서 iOS 홈 화면 추가→standalone 실행·재실행·S6 |
| FR-CLIENT-04 | `FR-CLIENT-04 SW·Cache Storage·IndexedDB·localStorage에 본문·인증 응답이 없고 API·WS는 캐시를 우회하며 로그아웃 시 화면 본문이 지워진다` | 컴포넌트 `web/test/pwa/no-persist.test.ts` + `check:no-persist-cache` | PR | `QA-FR-CLIENT-04`: 실기 저장소 검사(ego-browser 개발자 도구) |
| FR-CLIENT-07 | `FR-CLIENT-07 주요 조작에 접근 가능한 이름·가시 포커스가 있고 전송·연결 상태를 텍스트로 표시한다` | 컴포넌트 `web/test/a11y/labels.test.tsx` | PR | `QA-FR-CLIENT-07`: 200% 확대 주요 조작 |
| FR-OPS-01 | `FR-OPS-01 서버 기본 바인드 주소는 127.0.0.1이고 tailnet 접근만으로 로그인이 생략되지 않는다` | 통합 `server/test/ops/bind.int.test.ts` | PR | `QA-FR-OPS-01`: tailnet 밖·LAN 기기 접속 불가, Serve HTTPS만 허용, Funnel 꺼짐 확인 |
| FR-OPS-02 | `FR-OPS-02 격리 복원본과 원본의 메시지·수정/삭제 상태·DM 멤버십·읽음 커서·seq 연속성이 일치한다` | 드릴 `tools/restore-drill.sh`(합성 데이터) | G1 | — |
| FR-OPS-03 | `FR-OPS-03 합성 본문·자격 증명·토큰 카나리아가 앱·HTTP·WS 로그에 0건이고 허용 계측 필드만 기록된다` | 통합 `server/test/ops/log-redaction.int.test.ts` + `check:log-leak` | PR | `QA-FR-OPS-03`: Tailscale Serve 쪽 로그 점검 |
| FR-OPS-04 | `FR-OPS-04 CLEANROOM 5절 검사가 0건이고 스캐너 오류는 실패로 처리된다` | 스크립트 `pnpm check:cleanroom`(검사기 자체 테스트 포함) | PR | `QA-FR-OPS-04`: 디자인 출처 검토(DESIGN_REFERENCE 대조) |

- **합계:** AUTH 5 · CONV 4 · MSG 8 · SYNC 7 · CLIENT 5 · OPS 4 = **33**. PRD 표에서 우선순위 `P0` 행을 grep으로 센 값과 같습니다.
- **TRD의 `TR-SEC-nn`:** TRD가 나오면 R3에서 같은 형식의 보조 표(TR-SEC → 테스트)를 추가합니다. 현재 FR-AUTH-06·CONV-04·MSG-01·OPS-03이 보안 요구의 주 판정 테스트입니다.

## 7. 위험

| ID | 위험 | 영향 | 대응 | 상태 |
|---|---|---|---|---|
| R-01 | 테스트가 운영 DB `ohmyslack`에 붙음 | 실데이터 파괴 | DB 이름 `_test` 접미사 강제, 아니면 즉시 실패(5-1) | 설계 |
| R-02 | 브라우저 자동 E2E 부재 | UI 회귀가 PR에서 안 잡힘 | 컴포넌트 테스트 + 프로토콜 E2E + 단계 게이트 수동 QA. 범위는 ⚖️-2 | ⚖️ |
| R-03 | iOS PWA 백그라운드에서 WS 끊김 | 복귀 직후 오래된 화면 | `visibilitychange` 복귀 때 항상 커서 따라잡기, 완료 전 "동기화 중" 표시(FR-SYNC-07) | 설계 |
| R-04 | 맥 잠자기·종료 | 모든 기기 접속 불가 | UI 연결 끊김 표시. 상시 구동 방식은 ⚖️-5 | ⚖️ |
| R-05 | 로컬 개발(http://localhost)과 운영(Serve HTTPS)의 쿠키 `Secure`·Origin 차이 | 개발에서는 통과, 운영에서 로그인 실패 | 설정을 환경별로 분리하고 G1 QA는 Serve HTTPS 경로에서 수행. 브라우저별 localhost `Secure` 쿠키 처리는 확인 필요 | 확인 필요 |
| R-06 | 문서 간 ID·이름 드리프트(PRD FR·TRD 테이블/이벤트·디자인 컴포넌트) | 테스트 매핑 누락 | `check:fr-coverage`로 FR 누락은 기계 차단. 테이블·이벤트명은 R3에서 10절 가정 정리 | 설계 |
| R-07 | 클린룸 누출(참고 이미지·색·소리) | 상표·트레이드 드레스 위험 | `check:cleanroom` + Designer 출처 표기 + QA-FR-OPS-04 출처 검토 | 설계 |
| R-08 | 대화 행 `last_seq` 갱신 경합 | 처리량 저하 | 개인 규모에서는 영향 작다고 추정(미측정). FR-SYNC-01 부하에서 확인 | 추정 |
| R-09 | 단일 프로세스 메모리 팬아웃은 재시작 시 이벤트 유실 | 일시적 미표시 | 재접속 따라잡기가 메움(B4). 다중 프로세스는 범위 밖 | 설계 |
| R-10 | Node 버전 표기 불일치: 2차 브리프 "Node v26.12.1 설치됨" vs 1차 C 문서 "Node 24.12.0" | 엔진 고정 오류 | **TRD가 결정**합니다. 이 문서는 `engines`·`.nvmrc`를 TRD 값으로 고정한다고만 가정합니다 | R3 정합 |

## 8. 하지 말 것 (개발 단계)

1. 운영 DB에 테스트·마이그레이션 실험을 하지 않습니다. `.env` 값을 읽거나 로그·문서에 남기지 않습니다.
2. shared-infra의 compose·`backup.sh`·ACL을 수정하지 않습니다. 임시 복원 DB 생성은 승인 후 운영 절차로 합니다.
3. Redis·메시지 브로커·마이크로서비스를 넣지 않습니다(확정 결정 0-6).
4. 대화 본문을 기기 저장소에 지속 캐시하지 않습니다(FR-CLIENT-04).
5. Slack 코드·에셋·스크린샷·색·소리·폰트를 쓰지 않습니다. CLEANROOM 금지 문자열 목록을 다른 파일에 복제하지 않습니다.
6. Playwright·Puppeteer를 저장소에 설치하지 않습니다(영환님 전역 규칙). 브라우저 확인은 ego-browser로만 합니다.
7. Tailscale Funnel을 켜지 않습니다. 서버를 `0.0.0.0`에 바인드하지 않습니다.
8. 수동 체크를 실행하지 않고 "통과"로 표시하지 않습니다. 미검증은 미검증으로 보고합니다.

## 9. 결정 필요(⚖️) — 위험 순

| ID | 결정 | R1 권고 | 시점 |
|---|---|---|---|
| ⚖️-1 | 통합 테스트용 DB `ohmyslack_test`(+전용 role) 생성 | 생성 권고. shared-infra 변경이므로 운영자(영환님) 승인 필요. 대안은 CI 서비스 컨테이너만 쓰고 로컬 통합 테스트를 포기하는 것인데, 권하지 않습니다 | G0 |
| ⚖️-2 | 브라우저 자동 E2E 수준 | 전역 규칙을 유지하고 수동 QA(ego-browser·실기기)로 메우는 안 권고. 규칙 예외를 둘지는 영환님만 정할 수 있습니다 | G0 |
| ⚖️-3 | CI 실행 위치 | GitHub Actions + PG 15 서비스 권고. 비공개 저장소 사용량 조건은 확인 필요. 쓰지 않으면 로컬 게이트 + QA 재실행 | G0 |
| ⚖️-4 | FR-OPS-02 격리 복원 대상 DB | 드릴할 때만 만들고 끝나면 지우는 임시 DB 권고. 생성·삭제는 승인된 운영 절차로 합니다 | W-13 전 |
| ⚖️-5 | 맥 상시 구동(launchd 등)과 Tailscale Serve 설정 적용 | 런북 작성(W-12) 후 영환님이 적용. 이 문서는 적용을 승인하지 않습니다 | 파일럿 전 |
| ⚖️-6 | 커버리지 80%의 적용 범위 | 전 패키지 라인 80% 권고(영환님 전역 규칙). 부하·수동 항목은 제외 | G0 |

## 10. 문서 간 정합 가정 (R3 대상)

| # | 이 문서의 가정 | 맞출 문서 |
|---|---|---|
| A1 | P0 FR 목록 = PRD v1.1(GPT-Sol R1)의 33개. PRD가 바뀌면 6절 표와 `check:fr-coverage`가 함께 바뀝니다 | PRD |
| A2 | 테이블: 사용자·세션·초대·대화(`kind=channel|dm`, `last_seq`)·멤버십·`messages`(`client_message_id`·`thread_root_id`·`edited_at`·`deleted_at`)·읽음 상태(본문/스레드)·멘션·변경 로그. 이름은 1차 GPT-Luna 문서를 따랐습니다 | TRD |
| A3 | 이벤트: `message.created|updated|deleted`, `read.updated`. 변경 커서 API `GET /api/sync?since=` | TRD |
| A4 | 쿼리 계층·마이그레이션 도구·Node 버전·쿠키 속성·로그인 제한 수치는 TRD가 정합니다. 이 문서는 "순서형 SQL 파일"만 가정합니다 | TRD |
| A5 | 컴포넌트·브레이크포인트(640px)·포커스 순서는 디자인 레퍼런스가 정합니다. 테스트 파일명은 그 이름에 맞춰 바꿉니다 | DESIGN_REFERENCE |
| A6 | 계측 이벤트·허용 필드는 PRD 10절을 그대로 따릅니다. 로거 허용 목록(B6)이 그 표를 구현합니다 | PRD·TRD |

## 사실 / 추정 / 확인 필요

- **사실:** PRD v1.1의 우선순위 P0 FR은 33개입니다(PRD 표 grep). shared-infra PostgreSQL은 15이고 `backup.sh`가 있습니다(README·compose). 브리프 0절의 확정 결정 6개를 이 문서의 전제로 썼습니다.
- **추정:** 모듈 6개 분할, slice 순서, 크기 S/M/L, `last_seq` 경합 영향은 설계 판단입니다. 측정이나 구현 결과가 아닙니다.
- **확인 필요:** GitHub Actions 사용 조건, Electron fuse 이름의 착수 시점 표기, 브라우저별 localhost `Secure` 쿠키 처리, Node 버전(R-10).

## 변경 이력

| 버전 | 날짜 | 내용 |
|---|---|---|
| R1 | 2026-11-07 | 최초 작성. PRD v1.1(P0 FR 33개)에 매핑. TRD·디자인 레퍼런스는 미도착이라 가정으로 표시 |
