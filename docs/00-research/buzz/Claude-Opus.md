---
title: "ohmyslack — D. 교차검토·실행 계획 (Claude-Opus 5.5)"
tags: [ohmyslack, cross-review, execution-plan]
status: draft
created: 2026-11-07
---

# D. 교차검토·실행 계획 — v0 초안 (A–C 미반영)

> 작성: Claude-Opus 5.5 (pubkey `7484092c…`), 2026-11-07
> 상태: **v1 — A(Claude-Fable)·B(GPT-Sol)·C(GPT-Luna) 전부 반영.** (최초 v0 기준:) 작성 시점에 `docs/00-research/buzz/` 는 비어 있었고 스레드에 A–C 답글이 없었습니다. 브리프 3-D의 "0–2번만 보고 초안" 허용 조항에 따라 작성했습니다. A–C가 올라오면 6절(충돌 정리)을 채워 갱신합니다.
> 결정은 영환님이 내립니다. 아래는 권고입니다.

## 1. 결론

1. **추천: 방향 1 (클린룸 자체 서버).** 단, 기대치를 조정해야 합니다. REA 분석은 Slack 채팅 제품 구현에 거의 기여하지 못합니다. 채팅 UI가 원격 웹앱(`app.slack.com/ssb/first`)이고, 웹앱 코드는 복원 금지 대상인 Service Worker 캐시에 있습니다. REA가 준 것은 **Electron 셸의 보안 기본값·딥링크·트레이/알림 패턴**이며, 이는 MVP가 아니라 **데스크톱 단계(P3)**에서 쓰입니다.
2. **[v1 정정] 방향 2·4(실시간 브리지)는 약관상 비권고입니다.** A가 확인한 API Terms(2025-10-10) (C) "access our APIs in order to replicate or compete with the Services"와 Developer Policy "replicate or compete with core products"는 내부 사용 예외가 없습니다(A 파일 T1·T4). 아래 v0 문장은 레이트리밋 조건으로는 맞지만, 약관 조항은 그 조건으로 해소되지 않습니다. 방향 4는 **공식 export 파일 1회 가져오기**로 축소한 변형만 P4 후보로 남깁니다.
   - (v0 원문) **방향 2·4는 "회사 워크스페이스 + 관리자 승인 + 내부 앱" 조건이 맞아야만 성립합니다.** Slack은 2025-05-29부터 Marketplace 밖에서 배포되는 앱의 `conversations.history`/`replies`를 1회/분·15건으로 제한했습니다. 내부(customer-built) 앱만 기존 한도(50+회/분, 1,000건)를 유지합니다. 개인용 커스텀 클라이언트나 브리지는 이 조건과 회사 정책에 묶입니다.
3. **MVP는 브리프 2번의 10개 항목보다 좁혀야 합니다.** D 권고: MVP = 텍스트 메시징 골격(워크스페이스 1·채널·DM·스레드·멘션·unread·실시간)입니다. 파일·검색·presence는 v1(P2)로 미룹니다. 최종 컷은 B(GPT-Sol)의 분류를 따릅니다.

### 방향 점수표 (1–5, D 관점: 실행 가능성 × 위험 × 되돌림 비용)

| 방향 | 점수 | 한 줄 근거 |
|---|---|---|
| 1. 클린룸 자체 서버 | **4** | 외부 종속·약관 위험이 가장 낮습니다. 비용은 구현량입니다. shared-infra(Postgres·Redis)를 재사용할 수 있습니다. |
| 2. 기존 Slack 워크스페이스용 커스텀 클라이언트 | **1** (v0 2점 → A 근거로 하향) | 관리자 승인, 토큰 범위, 레이트리밋에 묶입니다. Slack을 "대체"하지 못하고 "덧씌우기"에 그칩니다. |
| 3. REA 보고서만 | 2 | 위험은 0입니다. 다만 핵심 증거(셸 구조)는 이미 확보돼 추가 가치가 작습니다. |
| 4. 하이브리드 (1 + Slack 브리지) | 실시간 브리지 **2** / export 1회 가져오기 **3** | 실시간 브리지는 방향 2와 같은 조항과 API 데이터 보존 제한(A T3)에 닿습니다. 공식 export 1회 가져오기만 P4 후보입니다. MVP에는 넣지 않습니다. |

## 2. 근거

| ID | 내용 | 출처 |
|---|---|---|
| E1 | Electron fuse: RunAsNode·NODE_OPTIONS·`--inspect` 비활성, ASAR 무결성·OnlyLoadAppFromAsar 활성 | 브리프 0-1, REA `ev_d4bb9636…` |
| E2 | 첫 화면 `https://app.slack.com/ssb/first` → 채팅 UI는 원격 웹앱. 창 3종, IPC 52건, 네이티브 모듈 8종, `slack://` 딥링크, contextIsolation·sandbox on | 브리프 0-2, REA `ev_f49e0e82…`/`ev_70bb0ffb…` |
| E3 | 웹앱 코드는 Service Worker 캐시(~493MB)에 있음. 복원 도구 `recover_javascript_sources`는 Linux x64 전용 | 브리프 0-3 |
| E4 | 비-Marketplace 배포 앱: `conversations.history`/`replies` 1회/분·최대 15건(2025-05-29부터 신규 앱·신규 설치). 내부 customer-built 앱은 50+회/분·1,000건 유지 | https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps , https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity (검색 결과 발췌로 확인. `docs.slack.dev/robots.txt` 는 `Allow: /`) |
| E5 | 같은 변경이 API 이용약관(API Terms of Service) 갱신과 함께 발표됨("updates to the API Terms of Service") | E4 첫 번째 URL 본문 발췌 |
| E6 | `~/Work/shared-infra/docker-compose.yml` 서비스는 `postgres`(15-alpine)·`redis`(7-alpine) 2개뿐. MinIO 없음 | 파일 직접 확인(6·37행) |
| E7 | `~/Work/shared-infra/add-project.sh <db_name> <redis_db_number>`: 멱등, `down -v` 미사용, 새 DB를 라이브 컨테이너에 생성 | 파일 헤더 직접 확인(1–20행) |

## 3. 사실 / 추정 / 확인 필요

**사실**
- E1–E7 전부.
- `docs/00-research/buzz/`는 이 파일 작성 시점에 비어 있었습니다.

**추정**
- REA 산출물 중 구현에 재사용 가능한 것은 셸 설정 패턴(보안 webPreferences, fuse 잠금, 딥링크 스킴, 트레이/알림) 정도입니다. 이는 Electron 공식 보안 체크리스트와 대부분 겹칩니다. 그러므로 "REA로 분석해서 구현"의 실질 기여는 작습니다.
- 1인 개발 기준 일정 추정(근거: 일반적인 CRUD+WebSocket 앱 규모, 검증 안 됨): P1 약 1–2주, P2 약 1–2주, P3 약 1주입니다.

**확인 필요**
- (A) Slack User Terms·AUP·데스크톱 라이선스의 리버스 엔지니어링 조항 원문. 이번 정적 분석 자체가 조항에 걸리는지도 포함합니다.
- (A) 이름 "ohmyslack"의 상표 위험. 외부 공개 계획이 있으면 중요합니다.
- (A) 방향 4의 가져오기·동기화가 2025년 API ToS 데이터 이용 조항과 충돌하는지(E5).
- (B) MVP 항목 컷. 브리프 10개 항목과 D의 축소안 중 어느 쪽인지 정합니다.
- ~~(C) Redis DB 번호 충돌 여부~~ → C가 해소: DB 번호는 권한 경계가 아니고 ACL이 ohmyslack 키·Pub/Sub를 막음(6-C). 남은 것: 파일 저장소로 MinIO를 shared-infra에 추가할지 로컬 디스크로 시작할지(P2).
- 영환님이 쓰는 Slack이 회사 워크스페이스인지 개인 워크스페이스인지. 방향 2·4의 성립 여부가 여기서 갈립니다.

## 4. 단계별 계획 (P0–P4)

| 단계 | 목표 | 완료 기준 | 선행 결정 |
|---|---|---|---|
| **P0 결정·준비** | 방향·이름·배포 범위 확정, 클린룸 규칙 문서화 | 결정 기록 1장. `CLEANROOM.md`(볼 수 있는 것: 공개 문서·UI 관찰 / 쓸 수 없는 것: 코드·에셋). Git 저장소 init. 공유 PostgreSQL에 `ohmyslack` DB + 전용 role 추가(운영자 승인 후, role은 `add-project.sh`와 별도 절차 — C 근거). **Redis는 연결하지 않음**(6-C) | 7절 1–4, 9 |
| **P1 MVP: 메시징 골격** | 워크스페이스 1·초대·로그인·채널·1:1 DM·1단 스레드·수정/삭제·멘션·unread·WebSocket 실시간·재접속 복구. 구조는 C안: PostgreSQL 단일 원장 + 채널별 `seq` + idempotency key + 채널·스레드별 읽음 커서 + 단일 Fastify HTTP/WS 프로세스 | 두 브라우저 세션에서 송수신 1초 이내 반영. 새로고침 후 unread 정확. 스레드 답글 수 일치. 테스트 커버리지 80% | P0 |
| **P2 v1: 협업 기본** | 파일 업로드, 검색(Postgres FTS), presence, 웹 알림 | 업로드·다운로드 왕복. 검색 결과에 권한 밖 채널 미노출. presence 끊김 감지 | 7절 5(MinIO) |
| **P3 데스크톱 셸** | Electron 래핑. 보안 기본값 적용(contextIsolation·sandbox on, nodeIntegration off, fuse 잠금, 자체 딥링크, 트레이·알림). **출처는 Electron 공식 문서로 대체**합니다(A 5-2) | 패키징 앱의 fuse 상태를 REA `inspect_electron_fuses`로 Slack과 같은 수준인지 확인 | P2 |
| **P4 선택: Slack 데이터 가져오기** | 공식 워크스페이스 export 파일 1회 가져오기만. 실시간 브리지는 약관상 제외(A T1·T3·T4) | A의 약관 판정 통과 + 회사 워크스페이스면 관리자 승인 | 7절 4 |

## 5. 하지 말 것 (do-not-do)

1. Slack Service Worker 캐시나 웹앱 소스를 다운로드·복원·열람하지 않습니다(브리프 4번).
2. 실행 중인 Slack에 디버거·Inspector·Frida를 연결하지 않습니다. Slack.app을 수정·재서명하지 않습니다.
3. 로그인된 실제 워크스페이스 데이터(메시지·사용자 목록)를 조회·추출하지 않습니다. P4에서도 공식 export·공식 API만 씁니다.
4. Slack의 사운드·폰트·아이콘·로고·색상 팔레트, 픽셀 단위 UI 복제를 쓰지 않습니다. 레이아웃 관례(사이드바·스레드 패널)만 참고합니다.
5. shared-infra에서 `docker compose down -v`나 볼륨 삭제를 하지 않습니다. MinIO 추가는 다른 프로젝트 영향 확인 후에만 합니다. **Redis DB 번호만 바꿔 연결하지 않습니다**(ACL이 막고, 우회하려면 공용 ACL 변경·재생성이 필요 — 6-C).
6. MVP에 Huddle·통화·앱 마켓·Enterprise Grid·Slack 브리지를 넣지 않습니다.
7. 사용자 토큰(xoxp)으로 Slack 대화 이력을 대량 수집하는 "임시 동기화"를 만들지 않습니다(E4·E5, A T3).
8. **Slack.app 대상 REA 추가 분석을 하지 않습니다**(preload 그래프 보완, `.node` 디스어셈블, 로컬 SQLite 열람 포함). 설치본이 Mac App Store 빌드라 Apple 표준 EULA의 리버스 엔지니어링 금지가 걸립니다(A L1·L3). 이후 REA는 우리 P3 패키지 검증에만 씁니다.
9. Slack 이름·변형을 도메인·상표 출원·외부 제품명에 쓰지 않습니다(A T8). REA 결과의 코드 조각을 저장소에 넣지 않습니다.

## 6. A–C 충돌 정리

### 6-B. GPT-Sol(B) 반영 — 2026-11-07 (A·C 미도착)

출처: `buzz/GPT-Sol.md` 14–23행(점수), 49–91행(분류), 93–111행(시나리오·게이트), 113–118행(결정 후보).

| 쟁점 | B | D v0 | 정리 |
|---|---|---|---|
| 추천 방향 | 1 | 1 | **일치.** |
| MVP 범위 | 초대·로그인·채널·1:1 DM·1단 스레드·수정/삭제·멘션·unread·실시간/재접속 복구. 파일·검색·presence·Electron은 v1 | 채널·DM·스레드·멘션·unread·실시간. 파일·검색·presence는 v1 | **일치. D의 P1을 B 기준으로 넓힙니다.** 초대·로그인, 수정/삭제, 재접속 누락 복구를 P1에 포함합니다. P1 완료 기준은 B의 S1–S5와 공통 출시 게이트(DM 접근 차단, 저장 확인 메시지의 영속성, 재시도 중복 방지, 재접속 누락 복구, 스레드 읽음 상태)로 대체합니다. |
| 방향 4 점수 | 1 (MVP·v1 제외) | 3 (P4 선택지) | **실질 충돌 아님.** 둘 다 MVP·v1에서는 제외합니다. B는 범위·일정 관점, D는 장기 선택지 보존 관점에서 매긴 점수입니다. P4는 "별도 결정 후보"로만 남깁니다. |
| 방향 3 점수 | 3 | 2 | 관점 차이입니다. 결론에 영향은 없습니다. |
| 일정 | 달력 일정 제시 안 함 | P1–P3 각 1–2주 추정 | **B 쪽이 더 보수적이라 B를 따릅니다.** 3절의 일정 추정은 근거가 약하니 참고만 하십시오. 산정은 수용 기준을 작업으로 분해한 뒤 합니다. |
| 결정 항목 | 방향 → 첫 사용자 → MVP 축소 → 계정·운영 경계 | 방향 → 배포 범위 → 이름 → Slack 연동 … | 7절에 B의 "계정·운영 경계"(초대 방식·인증 제공자·백업 책임자·삭제 보존 의미)를 추가합니다. |

### 6-C. GPT-Luna(C) 반영 — 2026-11-07

출처: `buzz/GPT-Luna.md` 8–12행(결론), 14–23행(점수), 68–80행(실시간·로컬 환경), 107–113행(결정 후보). Redis 주장은 D가 원문으로 재확인했습니다: `~/Work/shared-infra/docs/security/redis-isolation.md` 17–24행(`resetkeys ~gallery:* ~galgen:* ~usage:* ~rl:* ~test:* resetchannels`), 44행("DB 번호는 경계가 아니다").

| 쟁점 | C | D v0.1 | 정리 |
|---|---|---|---|
| 추천 방향 | 1 (4번 2점) | 1 (4번 3점) | **일치.** 점수 차이는 결론에 영향 없음. |
| Redis | MVP에서 제외. 공용 Redis ACL이 ohmyslack 키·Pub/Sub를 허용하지 않음 | P0에서 `add-project.sh`에 Redis DB 번호 지정 | **D가 틀렸습니다. C를 따릅니다.** 브리프 2번의 "Redis 새 DB 번호로 pub/sub·presence·unread"는 현재 인프라에서 성립하지 않습니다. unread는 PostgreSQL 읽음 커서, 실시간은 단일 프로세스 WS로 처리합니다. 다중 프로세스가 필요해지면 PostgreSQL outbox를 먼저 검토하고, Redis는 전용 사용자·접두어를 운영 승인받은 뒤에만 씁니다. |
| DB 생성 | DB + 전용 role, 운영자 승인 항목 | `add-project.sh`로 DB 생성 | C 보강을 반영했습니다. role 생성·권한은 별도 절차입니다. |
| 스택 | 브리프 FE/BE 유지, MinIO·Meilisearch·Electron은 MVP 미설치 | 같은 방향 | 일치. |
| 단계 | P1 웹 MVP → P2 검색/파일/presence → P3 Electron → P4 Slack 재검토 | 같은 순서 | **일치.** |

### 6-A. Claude-Fable(A) 반영 — 2026-11-07

출처: `buzz/Claude-Fable.md` 21–31행(점수), 43–65행(약관·라이선스 원문 T1–T9, L1–L4), 105–117행(클린룸 경계), 119–135행(REA), 136–141행(교차 코멘트).

| 쟁점 | A | D v0.2 | 정리 |
|---|---|---|---|
| 방향 2 점수 | 1 (약관 "replicate or compete", 내부 예외 없음) | 2 (레이트리밋·관리자 승인 근거) | **A가 맞습니다. 1점으로 내립니다.** D는 레이트리밋만 보고 약관 조항을 확인하지 않았습니다. |
| 방향 4 | 실시간 브리지 2, export 1회 가져오기 3 | 3 (export 우선, 브리지 후순위) | **A 기준으로 나눕니다.** 실시간 브리지는 P4에서도 제외합니다. |
| REA 추가 분석 | Slack.app 대상 중단(Mac App Store 빌드 → Apple EULA). 셸 패턴 출처는 Electron 공식 문서로 대체 | P3 완료 기준에만 REA 사용 | **일치·강화.** 하지 말 것 8번에 반영했습니다. |
| 이름 | 내부 코드명 허용, 공개 전 개명. "slack" 포함 도메인·상표 출원은 어떤 경우에도 불가 | 결정 3순위 | **일치.** |
| 위험 순위 | 방향 → 공개 범위 → 이름 | 같음 | **일치.** |

### 6-종합. 네 파일의 합의와 남은 차이

- **합의(4/4):** 방향 1 추천. MVP는 웹 메시징 골격이며 파일·검색·presence·Electron은 v1 이후입니다. Slack 코드·에셋·워크스페이스 데이터는 쓰지 않습니다.
- **합의(3/3 해당자):** Redis는 MVP에서 제외합니다(C, D 정정). 실시간 브리지는 제외합니다(A·B·C, D 정정).
- **남은 차이:** 방향 3·4 점수뿐입니다. 결론과 계획에는 영향이 없습니다.

| 방향 | A | B | C | D v1 |
|---|---|---|---|---|
| 1 | 4 | 5 | 5 | 4 |
| 2 | 1 | 2 | 2 | 1 |
| 3 | 2 | 3 | 2 | 2 |
| 4 | 2 (export만 3) | 1 | 2 | 2 (export만 3) |

## 7. 영환님 결정 항목 (v1 통합, 위험·되돌림 비용 높은 순)

### 7-1. 착수 전 (P0) — 되돌리기 어려움
1. **방향: 1 단독 / 1 + P4 export 1회 가져오기.** 방향 2와 실시간 브리지는 네 에이전트 모두 비권고입니다(약관 A T1·T4). D 권고: 1 + P4 export 여지 유지.
2. **공개 범위: 개인 로컬 / 팀 내부 / 외부 공개.** 외부 공개를 고르면 3번(개명)과 5번(약관 확인)이 필수가 됩니다.
3. **이름:** "ohmyslack"은 내부 코드명으로만 쓰고, 공개 전에 개명합니다. "slack"이 들어간 도메인·상표 출원은 어떤 경우에도 하지 않습니다(A T8).
4. **REA 종료 선언:** Slack.app 대상 추가 분석을 중단하고 기존 결과는 내부 메모로만 보관합니다. 셸 패턴 출처는 Electron 공식 문서로 대체합니다(A 5-2, L3).
5. **미확보 약관 확인 배정 (A C1–C3):** App Store 리스팅의 커스텀 EULA 유무(약 1분), Salesforce MSA/AUP 원문(약 10분, 브라우저 직접), 한국 저작권법 제101조의3·4(약 5분). 영환님이 직접 보실지, 변호사 검토로 넘길지 정합니다. 시간은 A의 추정입니다.

### 7-2. P1 시작 전 — 공용 인프라·설계
6. **공유 PostgreSQL에 `ohmyslack` DB·전용 role 추가 승인** (C). 되돌리기는 쉽지만 공용 인프라 변경입니다.
7. **MVP 범위 승인 (B안):** 단일 워크스페이스, 초대·로그인, 채널, 1:1 DM, 1단 스레드, 수정/삭제, 멘션, unread, 실시간·재접속 복구. 파일·검색·presence·Electron은 v1로 미룹니다.
8. **MVP 데이터·서버 경계 승인 (C안):** PostgreSQL 단일 원장, 채널별 seq, idempotency key, 읽음 커서, 단일 Fastify HTTP/WS. Redis는 쓰지 않습니다.
9. **계정·운영 경계 (B):** 초대 방식, 인증 제공자, 관리자, 백업 책임자, 삭제한 메시지의 보존 의미.
10. **CLEANROOM.md를 P0 산출물로 채택 (A 4-3):** 출처 URL 기록, Slack 코드·에셋 미사용 선언과 grep 검증, 비-Slack 디자인 토큰 출처, 이름 결정 기록.

### 7-3. 나중 (P2–P3 전)
11. **파일 저장소:** shared-infra에 MinIO 추가 / 프로젝트 로컬 디스크.
12. **Electron 착수 시점:** P3(웹 MVP 검증 후). 네 에이전트 모두 같은 의견입니다.
