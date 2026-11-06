---
title: "ohmyslack 아키텍처·기반환경 — GPT-Luna"
tags: [ohmyslack, architecture, local-infra]
status: draft
created: 2026-11-07
---

# 결론

**방향 1(클린룸 자체 서버)을 권고합니다.** 브리프의 React·TypeScript·Vite와 Node 24 기반은 MVP에 적합합니다. 백엔드는 Fastify 단일 앱, PostgreSQL을 메시지의 유일한 원장, 브라우저 WebSocket을 실시간 알림 경로로 두십시오. 채널별 순번과 읽음 커서를 PostgreSQL에 저장하고 재접속 시 그 순번부터 다시 조회하면, 별도 메시지 브로커 없이도 MVP의 저장·중복 방지·복구 계약을 만들 수 있습니다.

MVP 데이터는 공유 PostgreSQL에만 저장하는 안을 권합니다. 현재 shared-infra의 Redis는 Ohmyslack에 바로 연결 가능한 상태가 아닙니다. DB 번호만 나누어도 키 권한과 Pub/Sub ACL 문제가 해결되지 않습니다. **Redis는 MVP에서 제외**하고, 파일·검색·presence도 GPT-Sol 제안대로 v1로 미루십시오. Electron은 웹 MVP가 검증된 뒤 P3에서 별도 승인합니다.

## 방향 1–4 점수표

기준: **아키텍처의 독립성·MVP 구현 적합도**입니다. 5점일수록 현재 목표에 더 적합합니다. B의 범위·일정 점수, D의 실행 가능성·위험 점수와 평가 관점이 다릅니다.

| 방향 | 점수 | 근거 |
|---|---:|---|
| 1. 자체 서버 클린룸 | **5/5 — 추천** | 메시지·권한·저장 계약을 직접 정할 수 있어 B의 MVP와 맞습니다. |
| 2. 기존 Slack용 클라이언트 | 2/5 | 서버 원장을 직접 소유하지 않으며 OAuth·워크스페이스 관리자·공식 API 한도에 종속됩니다. |
| 3. REA 보고서만 | 2/5 | 가장 작은 구조지만 사용 가능한 메신저를 만들겠다는 목적은 충족하지 않습니다. |
| 4. 자체 서버 + 실시간 Slack API 브리지 | 2/5 | 별도 메시지 ID·수정·삭제·재시도 동기화가 필요하고, A의 약관 판정상 실시간 API 브리지는 비권고입니다. 이 점수는 아키텍처 비교용이며 허용·착수 권고가 아닙니다. |

# 근거

| ID | 근거 | 아키텍처 영향 |
|---|---|---|
| C1 | [BUZZ_BRIEF.md:9–20](../BUZZ_BRIEF.md), REA 증거 `ev_d4bb9636…`, `ev_f49e0e82…`, `ev_70bb0ffb…` | Slack의 채팅 UI는 원격 웹앱이고 현재 결과의 커버리지는 partial입니다. 새 웹 제품과 데스크톱 셸을 분리하며, Slack 내부 계약을 구현 근거로 삼지 않습니다. |
| C2 | [BUZZ_BRIEF.md:24–35](../BUZZ_BRIEF.md) 및 GPT-Sol 제안 `docs/00-research/buzz/GPT-Sol.md` | 방향 1과 단일 워크스페이스·채널·1:1 DM·1단 스레드·수정/삭제·멘션·읽음·실시간·재접속 복구를 기준으로 데이터 모델을 잡습니다. 파일·검색·presence·Electron은 v1로 미룹니다. |
| C3 | [shared-infra README.md:17–22, 39–55, 72–94](../../../../shared-infra/README.md), [docker-compose.yml:6–24, 37–80](../../../../shared-infra/docker-compose.yml) | 현재 공용 개발 인프라는 PostgreSQL 15와 Redis 7이며 MinIO는 없습니다. 새 DB와 role은 기존 데이터를 보존하는 프로젝트 추가 절차가 필요합니다. Redis 번호는 보안 경계가 아닙니다. |
| C4 | [Redis 격리 문서:21–49](../../../../shared-infra/docs/security/redis-isolation.md) | 현재 default Redis ACL은 Ohmyslack 키 접두어와 Pub/Sub 채널을 허용하지 않습니다. 새 DB 번호를 할당하는 것만으로는 Redis 사용이 가능해지지 않습니다. |
| C5 | [PostgreSQL 18 전체 텍스트 검색](https://www.postgresql.org/docs/current/textsearch.html), [LIMIT/OFFSET](https://www.postgresql.org/docs/current/queries-limit.html), [UPDATE](https://www.postgresql.org/docs/current/sql-update.html), [트랜잭션 격리](https://www.postgresql.org/docs/current/transaction-iso.html) | PostgreSQL에는 FTS, 조건부 정렬/페이지 질의, `UPDATE ... RETURNING`, 동시 갱신 대기가 있습니다. 이 문서의 초기 검색·순번·페이지 커서 제안은 이 기능을 활용하는 설계 추론입니다. |

외부 참조는 PostgreSQL 공식 사이트만 사용했습니다. `postgresql.org/robots.txt`를 먼저 확인했으며 `/docs/`는 차단 대상 목록에 없었습니다. 사이트의 정책 목록에는 이용약관 항목이 없고, 조사한 문서는 공개 제품 기술 문서입니다. Node·Fastify·Redis·Electron·MinIO 자료는 이번 판단의 근거로 사용하지 않았습니다. Slack 앱, 웹앱 소스, 실제 워크스페이스 데이터에는 접근하지 않았습니다.

# 아키텍처 제안

## 1. 애플리케이션 경계

- **웹 MVP:** React + TypeScript + Vite. TanStack Query는 HTTP 이력과 캐시를 관리하고, WebSocket 이벤트가 오면 해당 대화 캐시를 갱신합니다. 메시지 화면은 TanStack Virtual을 적용해 페이지 단위 이력을 렌더링합니다.
- **입력기:** 초기는 한글 IME 동작을 확인할 수 있는 멀티라인 입력창으로 제한합니다. 풍부한 편집기 플러그인보다 저장·전송 상태를 우선하고, 본문은 에디터 종속 JSON이 아닌 텍스트로 저장합니다.
- **API·실시간:** Fastify 단일 Node 프로세스에서 HTTP API와 WebSocket을 함께 제공합니다. MVP는 서비스 분리·마이크로서비스·별도 브로커를 두지 않습니다. 기존 팀이 NestJS 운영 경험을 이미 갖고 있다면 NestJS도 선택 가능하지만, 현재 범위만으로는 추가 모듈 계층의 이득이 작습니다.
- **런타임:** 브리프에 있는 Node 24.12.0을 시작점으로 삼되, 구현 착수 시 프로젝트가 실제 설치할 패치 버전을 고정하십시오. 이번 조사는 Node 지원기간이나 Fastify 최신 호환표를 독립 확인한 것이 아닙니다.
- **데스크톱:** 처음에는 일반 브라우저로 검증합니다. Electron은 `contextIsolation`·sandbox·`nodeIntegration:false`와 fuse 잠금, 자체 `ohmyslack://` 딥링크를 적용하는 P3 항목입니다. Slack에서 관찰한 패턴은 참고만 하고 Slack 코드·에셋을 재사용하지 않습니다.

## 2. 핵심 테이블 초안

| 테이블 | 주요 필드·제약 | 목적 |
|---|---|---|
| `workspaces`, `users`, `workspace_members` | 한 워크스페이스, 사용자 상태, 역할·가입/비활성 시각 | B의 초대·로그인과 서버 측 접근 검사의 기준 |
| `channels` | `kind=channel|dm`, `last_seq`, 1:1 DM이면 정규화된 멤버 쌍 키 | 채널과 DM을 같은 대화 API로 처리하고 같은 멤버 쌍의 DM 중복 생성을 방지 |
| `channel_members` | `(channel_id,user_id)` 유일, 가입/나가기 상태 | 채널·DM 접근을 모든 history/write/subscribe 요청에서 검사 |
| `messages` | `id`, `channel_id`, `seq`, `author_id`, `client_message_id`, `thread_root_id`, `body`, `created_at`, `edited_at`, `deleted_at`; `(channel_id,seq)` 유일, `(channel_id,author_id,client_message_id)` 유일 | 원문·1단 답글을 함께 저장하고 재시도로 생기는 중복을 차단 |
| `channel_read_state`, `thread_read_state` | 사용자·대화 키, `last_read_seq` | 채널 원문과 스레드 답글의 읽음 위치를 별도로 유지 |
| `message_mentions` | `(message_id,user_id)` 유일 | 멘션 검색·배지를 메시지 본문 파싱 결과와 분리해 조회 |

**순번·정렬:** 메시지 생성 트랜잭션 안에서 해당 `channels` 행의 `last_seq`를 원자적으로 1 증가시키고 반환값을 메시지 `seq`로 사용합니다. PostgreSQL은 같은 행을 갱신하려는 동시 트랜잭션을 직렬화하므로 한 채널 안에서 확정 순서를 만들 수 있습니다. 한 인기 채널의 쓰기가 그 행에 모이는 단순한 모델이므로 MVP에는 적합하지만, 고처리량 병목은 별도 측정 대상입니다. 사용자 시간은 표시용이고 정렬 기준으로 쓰지 않습니다.

이전 이력은 `WHERE channel_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?` 형태의 커서 페이지로 가져온 뒤 화면에서 역순 정렬합니다. 시간값만 쓰거나 깊은 `OFFSET`으로 페이지를 넘기지 않습니다. PostgreSQL 문서도 `LIMIT` 결과에는 고유한 `ORDER BY`가 필요하고 큰 `OFFSET`은 건너뛸 행을 계산해야 한다고 설명합니다(C5).

**재시도:** 클라이언트가 최초 전송 전에 만든 `client_message_id`를 재시도에도 유지합니다. 유일 제약과 함께 저장하면 저장은 됐지만 응답이 끊긴 요청을 다시 보내도 기존 메시지를 반환할 수 있습니다. 수정/삭제는 원문을 덮어 쓰지 않고 `edited_at`과 `deleted_at` 상태를 기록해 B의 삭제 자리 보존 수용 기준을 맞춥니다.

**읽음/unread:** 클라이언트가 실제 화면에 표시한 마지막 `seq`까지만 커서를 앞으로 이동시킵니다. 채널 unread는 최상위 메시지, 스레드 unread는 해당 `thread_root_id`의 답글을 기준으로 따로 계산합니다. 작성자 본인의 메시지와 삭제 자리표시자는 unread 수에서 제외합니다. 처음에는 이력에서 계산하고, 측정 전에는 집계 캐시를 추가하지 않습니다.

**검색·파일:** 검색은 v1에서 PostgreSQL FTS를 먼저 검토합니다. 현재 문서는 PostgreSQL 15이므로 적용 전에 해당 버전에서 표현식 인덱스와 필요한 언어 설정을 확인하고, 한국어 검색 품질을 실제 데이터가 아닌 합성 예제로 평가합니다. 파일 업로드는 v1로 미루십시오. 공유 인프라에 MinIO가 없으므로 시작 시 로컬 디스크를 임시 영구 저장소처럼 취급하지 않습니다.

## 3. 실시간·재접속 계약

1. HTTP 요청이 메시지를 PostgreSQL에 커밋한 뒤 서버가 `message.created|updated|deleted` 이벤트를 연결된 대화 참여자에게 보냅니다. 클라이언트는 `message_id`로 이미 받은 응답과 중복 제거합니다.
2. 연결 복구 시 클라이언트가 보관한 마지막 `seq`를 커서로 이력 API를 호출합니다. DB 이력이 진실의 원천이며 WebSocket은 즉시 표시를 위한 알림 경로입니다.
3. 쓰기 응답에 확정된 `seq`와 `message_id`를 반환합니다. 응답이 불명확할 때 같은 `client_message_id`로 재시도합니다.
4. 서버 재시작·네트워크 끊김 중 이벤트가 빠져도 재접속 이력 조회가 누락을 메웁니다. 이는 GPT-Sol S2·S5의 영속성·중복 방지·복구 게이트에 맞춘 설계 제안이며, 구현 또는 통과 결과가 아닙니다.
5. 여러 API 프로세스로 확장할 때는 인스턴스 간 전달을 새로 설계해야 합니다. 먼저 PostgreSQL outbox와 재생성 가능한 소비자를 검토하고, Redis를 쓰려면 ACL의 Ohmyslack 전용 키 접두어·Pub/Sub 채널 허용과 운영 승인을 확보해야 합니다. DB 번호만 바꾸어 Redis를 활성화하면 안 됩니다.

## 4. 로컬 개발환경

- **필수:** 공유 PostgreSQL의 `ohmyslack` DB와 전용 로그인 role. 현재 README는 `add-project.sh <db_name> <redis_db_number>`로 DB를 멱등 추가하고, role 생성·권한 연결을 별도로 하도록 안내합니다. DB/role 생성은 공유 인프라 변경이므로 이 설계 검토에서 실행하지 않았습니다.
- **Redis:** MVP 연결 설정을 만들지 않습니다. 이후 presence/분산 fan-out이 필요해지면 인프라 운영자와 ACL을 먼저 조율하거나, 별도 격리 인스턴스를 승인받습니다. DB 3+는 번호 구분일 뿐 권한 경계가 아닙니다.
- **로컬 프로세스:** Vite 개발 서버 + Fastify API/WebSocket 한 프로세스 + 기존 PostgreSQL만으로 개발을 시작합니다. MinIO·Meilisearch·Electron 설치를 요구하지 않습니다.
- **설정:** 프로젝트 전용 `.env`에 `DATABASE_URL`만 둡니다. 실제 연결 문자열·비밀 값은 문서·로그에 기록하지 않습니다. 스키마는 순서가 있는 SQL 마이그레이션으로 관리하고, 공용 인프라의 컨테이너·볼륨은 프로젝트가 내리거나 초기화하지 않습니다.

# 사실 / 추정 / 확인 필요

**사실**

- 브리프는 Slack 데스크톱의 진입점이 원격 웹앱이며 REA 파싱 범위가 partial이라고 기록합니다(C1).
- shared-infra compose는 PostgreSQL 15와 Redis 7을 제공하며 현재 프로젝트 추가 절차와 볼륨 보존 규칙이 있습니다(C3).
- Redis 격리 문서는 기본 사용자에 임의 Ohmyslack 키 접두어와 Pub/Sub 채널이 허용되지 않는다고 기록합니다(C4).
- 공식 PostgreSQL 문서는 전체 텍스트 검색, 정렬·제한 질의, `UPDATE ... RETURNING`, 동시 갱신 동작을 설명합니다(C5).
- GPT-Sol은 파일·검색·presence·Electron을 v1로 미루고, MVP에 초대·로그인·수정/삭제·재접속 복구를 포함합니다. Claude-Opus의 갱신 초안도 그 MVP를 따릅니다.

**추정 / 권고**

- 한 프로세스와 PostgreSQL만으로 초대 팀 파일럿의 동시성·재접속 요구를 충족할 수 있다고 봅니다. 성능 측정 전의 설계 가설입니다.
- 브리프의 Node 24.12.0은 개발 기반으로 재사용할 수 있지만, 이 조사는 지원 종료·보안 패치 기간을 판정하지 않았습니다.
- 채널 행 순번은 단순하고 정렬이 명확하지만, 대규모 단일 채널에 대한 처리량은 미측정입니다.

**확인 필요**

- 실제 초대·인증 방식과 앱이 팀 내부 전용인지 외부 공개인지.
- 공유 PostgreSQL에 `ohmyslack` DB와 전용 role을 추가할 운영자 승인 및 백업 범위.
- 브라우저 파일럿에서 검색·파일·presence 없이 일상 대화를 완수할 수 있는지.
- 검색이 v1에 들어갈 경우 한국어 형태소/토큰화 요구와 PostgreSQL 15의 적합성.
- 실시간 다중 프로세스 배포가 필요해질 때 선택할 전달 계층과 Redis ACL 변경 범위.

# 요구사항·결정 후보

1. **MVP 데이터 원장:** PostgreSQL 단일 원장, 채널별 `seq`, 클라이언트 idempotency key, 채널·스레드별 읽음 커서를 승인할지 결정해 주세요.
2. **MVP 서버 경계:** 단일 Node/Fastify 프로세스 + HTTP/WebSocket으로 시작하고 Redis 의존성을 제외할지 결정해 주세요.
3. **범위:** Sol 제안대로 파일·검색·presence·Electron을 v1로 미루고, 초대·로그인·편집/삭제·재접속 복구를 MVP에 둘지 결정해 주세요.
4. **공유 인프라:** 착수 전에 `ohmyslack` PostgreSQL DB/role 추가를 운영자에게 요청할지 결정해 주세요. 이 문서는 해당 변경을 실행하지 않았습니다.
5. **단계:** P1 웹 MVP → P2 검색/파일/presence → P3 Electron → P4 공식 export 1회 가져오기 검토 순서를 권고합니다. 실시간 Slack API 브리지는 P4 후보에서도 제외합니다.

검토 상태: 브리프, GPT-Sol/Claude-Opus 제안, shared-infra 문서·compose, PostgreSQL 공식 문서를 읽고 설계안을 작성했습니다. 이번 turn에서 코드 변경·패키지 설치·컨테이너 실행·DB 쓰기·Slack 앱/계정 접근·테스트 실행은 하지 않았습니다.

## 추가 검토 — Claude-Fable(A) 결과 반영

Fable의 A 보고서가 도착해 Slack 연동 판단을 구체화합니다. 아래 약관 결론은 A의 원문 조사 결과를 인용한 것이며, C가 법률 문서를 독립 검증한 것은 아닙니다.

- **방향 2와 실시간 API 브리지:** A는 Slack API Terms와 Developer Policy의 “replicate or compete” 금지 조항에 직접 닿으며 내부 사용 예외도 없다고 판정했습니다(A `Claude-Fable.md`, T1·T4). 따라서 C 점수표의 방향 2와 4 점수는 실시간 API 기반 연결의 아키텍처 적합도만 뜻하며, 허용 또는 착수 권고가 아닙니다. 실시간 브리지는 P4 후보에서도 제외하는 쪽으로 정정합니다.
- **방향 4의 좁은 변형:** 고객이 정당하게 받은 공식 export 파일을 1회 가져오는 방법은 실시간 API 브리지와 별도입니다. A는 이 변형의 법적 위험 점수를 3으로 평가했습니다. 데이터 형식·권리·삭제/보존 조건을 별도 검토한 뒤 P4에서 결정할 항목이며, C의 기존 방향 4 점수(2)는 live bridge에 대한 값입니다.
- **REA와 데스크톱 셸:** A는 Slack.app 대상 추가 분석을 중단하고 Electron 보안 패턴 출처를 공식 Electron 문서로 대체할 것을 권고했습니다. C의 P3 설계는 그 권고와 일치합니다. REA 분석 결과를 제품 코드·에셋으로 가져오지 않습니다.
- **이름·시각 디자인:** A의 보고서에 따르면 `ohmyslack`은 내부 코드명으로만 유지하고 공개 전 이름을 바꾸며, Slack의 색·소리·아이콘·폰트·룩앤필을 모방하지 않습니다. C 설계의 자체 UI·`ohmyslack://` 스킴 제안은 이름 공개 전 상표 확인을 전제로 합니다.

C 결론은 여전히 방향 1입니다. P4는 실시간 Slack API 연결이 아니라 공식 export 1회 가져오기만 별도 검토 후보로 남깁니다. Salesforce MSA/AUP 원문과 기타 A 보고서의 미확보 사항은 확인 필요 상태로 유지합니다.
