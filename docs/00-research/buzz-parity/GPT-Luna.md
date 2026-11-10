# GPT-Luna — 아키텍처·비용 검토

## 결론

전환 관찰 창(2026-11-10–11-16)에는 **제품 코드·Hermes 어댑터·푸시 경로를 바꾸지 않고**, FR 후보의 계약·한국어 검색 품질·수용 기준을 문서로 확정하는 일까지만 착수하는 편을 권고합니다. 11-17 이후에도 G1을 통과하기 전에는 기능 구현을 보류하고, 게이트 증거를 먼저 완성하십시오. 이후에는 **하이브리드**를 권고하되 1단계는 Jarvis 진행/첨부/clarify와 기기 세션 관리처럼 기존 P0를 보강하는 2–3개로 제한하고, 검색·presence 등은 별도 단계로 둡니다.

후보 검토는 브리프의 P1/P2 및 Hermes 공백을 기준으로 했습니다. GPT-Sol의 신규 상위 10개 목록은 이 파일 작성 시 경로에 아직 없어, 아래 순위는 **임시 아키텍처 우선순위**입니다.

| 임시 순위·후보 | 데이터/API/WS 영향 | 경계·의존 | 규모 |
|---|---|---|---|
| 1. 기기 세션 UI (FR-AUTH-04) | 기존 `sessions`, `GET /api/sessions`를 사용하고 세션 revoke API와 현재 기기 표시 UI를 추가합니다. revoke 시 기존 WS 종료 경로 재사용, 새 동기화 이벤트는 불필요합니다. | 계정 가드·CSRF와 세션 소유자 확인. 본문 캐시 없음. 의존성이 가장 적습니다. | S |
| 2. 검색 (FR-OPS-06) | `GET /api/search?q=&cursor=`와 메시지 ID/대화/작성자/시각/짧은 일치 문맥 응답을 제안합니다. 검색 전용 본문 복제 테이블 대신 `messages.body`에 대한 파생 `tsvector`/GIN 인덱스를 우선 검토하고, 수정·삭제와 색인을 원자적으로 맞춥니다. 결과가 파생 상태라 새 WS 이벤트나 `/api/sync` change는 불필요합니다. | 권한 있는 현재 대화만 SQL 단계에서 거르고 응답 전에 권한을 확정해야 합니다. 기존 단건 `assertAccess`만으로 다중 대화 검색을 판정하기 어려우므로 B2 중앙 권한 서비스에 bulk scope 계약을 추가하거나 검색 가능한 대화 ID 집합을 중앙 서비스가 제공해야 합니다. 결과·검색어는 브라우저 메모리에만 두며 SW/저장소·로그·계측에 남기지 않습니다. 한국어 토큰화/형태소 품질, PostgreSQL 운영 버전·확장 허용 여부가 선행 확인입니다. | L |
| 3. 입력 중·처리 상태 (FR-OPS-07 및 Hermes `send_typing`/processing 훅) | 새 ephemeral WS frame(예: `typing.started/stopped`, `bot.processing`)을 제안합니다. 저장 테이블, `conversation_changes`, sync cursor는 쓰지 않습니다. 단일 프로세스 메모리에서 연결별 TTL과 발신 제한을 관리합니다. | 구독 권한은 기존 `assertAccess` 재사용. 본문/상태를 브라우저에 지속 저장하지 않고 재연결 시 복구하지 않습니다. Redis 금지와 맞으며 프로세스 재시작/다중 인스턴스에서 상태 유실은 허용해야 합니다. | M |
| 4. 일반 문서 첨부 (FR-OPS-09; Hermes `send_document`) | `attachments`/`attachment_blobs`, 업로드·다운로드 라우트를 재사용하고 MIME 허용 목록, sniff, 크기 상한만 확장합니다. 새 WS 이벤트는 없고 기존 메시지 첨부 projection을 사용합니다. | PRD 계약대로 PDF·텍스트 등은 다운로드 전용(`Content-Disposition: attachment`), 인라인 렌더링 금지. 기존 no-store, nosniff, 비참여자 404, 만료·삭제, 본문 캐시 금지를 그대로 적용합니다. Hermes bot 리스너 공용 업로드 handler 및 `author_kind` 권한을 함께 확인해야 합니다. 확장자/MIME 선언은 신뢰하지 않습니다. | M |
| 5. Clarify·slash 확인 (Hermes `send_clarify`, `send_slash_confirm`) | 우선 기존 메시지/스레드 안의 명시적 텍스트 응답으로 구현 가능성을 검토합니다. 선택지·응답을 구조화한다면 shared schema와 bot reply API를 확장하되, 실행 승인과 같은 권한 검증·응답 thread binding을 적용합니다. | 본문 명령은 오너 작성자 검증을 유지. 확인 응답은 대화 본문이므로 기존 본문 지속 캐시 금지·삭제 규칙 적용. `send_exec_approval`과 한 묶음으로 계약 정의가 선행됩니다. | M |
| 6. 비공개 채널 (FR-CONV-05 중 분리 1차) | `conversations`에 visibility 또는 별도 비공개 구분을 추가하고 초대/멤버 추가 API, discover/list 필터, 멤버십 UI를 확장합니다. 가입 변경은 DB 커밋 뒤 멤버/구독 갱신 이벤트가 필요합니다. | B2 중앙 `assertAccess`에서 private 비멤버를 동일 404로 처리하고 history, snapshot, sync, WS subscribe, push까지 같은 멤버십을 강제해야 합니다. `/api/sync` payload 필터와 현재 membership 필터는 유지합니다. 비공개 채널만 그룹 DM·보관과 분리해 출시하는 편이 범위를 줄입니다. | L |
| 7. 반응 (FR-MSG-09의 이모지 반응 부분) | `message_reactions(message_id,user_id,emoji)` 관계 테이블/유일 제약을 추가합니다. 반응 변경을 DB commit 후 `reaction.updated` 이벤트로 내보내고, sync projection이 이벤트를 놓쳐도 복구되도록 reaction change를 전역 sync 계약에 포함할지 또는 snapshot에서 집계할지 결정해야 합니다. | 대화 멤버십과 메시지 소속을 B2에서 확인. 사용자 정의 이모지·이미지·사운드 대신 유니코드 문자만 허용하면 에셋 경계를 단순화합니다. P2이므로 당장 우선하지 않습니다. | M |
| 8. Jarvis 채널 참여 (FR-BOT-03의 제안 범위) | 기존 `conversation_members`와 `/api/bot/v1/me`, bot sync/WS 경로를 확장하고 owner UI의 봇 추가/제거 동작을 제공합니다. 별도 테이블은 기본적으로 불필요합니다. | TRD §5-2의 봇 허용 멤버십(Owner DM + owner가 명시한 채널)과 일치하지만 봇 토큰 자체의 join/멤버 조회 권한은 열지 않습니다. 사람 owner가 권한 있는 채널에서만 조작하고, 제거 즉시 구독·sync·push 범위에서 제외해야 합니다. `@channel`/자동 호출은 PRD 제외를 유지합니다. | M |
| 9. 버튼형 실행 승인 (FR-BOT-07 후보) | 승인 선택지를 WS/message schema에 붙이는 것만으로 완료되지 않습니다. 단회 nonce, 승인 대상·owner·대화·만료·소비 상태를 저장하는 승인 action 테이블/API와 원자적 consume 필요성을 설계하십시오. | 로그인 사용자/owner, 요청 스레드, 허용 action을 서버에서 재검증하고 만료·중복 클릭·재생을 거부해야 합니다. 텍스트 `/approve` 경로를 계속 지원하고 버튼을 표시 보조로 취급합니다. 위해 범위가 높아 별도 위협 검토와 기준이 선행입니다. | L |
| 10. 반응 외 메시지 편의(P2 저장/고정/예약) | 저장은 사용자별 `saved_messages`, 고정은 대화별 `pinned_messages` 테이블로 분리할 수 있습니다. 예약은 `scheduled_messages(due_at, status, …)`와 재시도 가능한 DB 기반 dispatcher가 필요하며 단순 프로세스 timer만으로는 재시작 후 예약을 보장하지 못합니다. | 저장/고정은 메시지 삭제·접근 철회와 동기화 의미를 결정해야 합니다. 예약 전송은 안정적인 배포/복구와 중복 방지 계약이 선행합니다. FR-MSG-09를 한 덩어리로 추진하지 말고 예약 전송은 후순위로 분리하십시오. | M(저장/고정), L(예약) |

### 방향 점수 (1–5)

| 후보 | 점수 | 판단 |
|---|---:|---|
| 1. Jarvis 대화 동등성 우선 | 4 | 핵심 사용 목적과 맞지만, 어댑터/푸시를 관찰 중 변경하면 전환 판정이 무효가 될 수 있습니다. |
| 2. 일반 메신저 동등성 우선 | 2 | 검색·비공개 채널은 가치가 있으나 개인 1인+Jarvis 맥락의 즉시 효용이 상대적으로 낮고 권한·검색 범위가 큽니다. |
| 3. 하이브리드 | 4 | 다음 단계 목표로 균형이 좋습니다. 2–3개로 제한하고 G1 이후 착수해야 합니다. |
| 4. 관찰/G1 전 동결 | 5 | 현재 관찰 창과 G1 미통과 상태를 보존합니다. **현 시점 추천**입니다. 기능 요구사항을 거부하는 결정이 아니라 착수 순서를 늦추는 결정입니다. |

**권고:** 지금은 #4, G1·11-17 전환 판정이 끝난 뒤에는 #3을 채택해도 될지 다시 결정합니다. 다음 단계 후보는 기기 세션 관리 + Jarvis clarify/처리 상태 + 일반 문서 첨부 중 수용 기준과 실제 사용 증거가 확인된 최대 3개입니다. 버튼 승인은 threat model 확인 뒤 별도 승인 대상으로 둡니다.

## 근거

- 기능 후보와 시점: `docs/00-research/BUZZ_SLACK_PARITY_BRIEF.md:28-50,57-70` (P1/P2 목록, 어댑터 공백, 관찰 창·G1, 담당 범위).
- 세션·채널·검색·presence·첨부·봇 FR: `docs/02-prd/PRD.md:54-87,114-127,150-167`; 검색의 권한 밖 결과 0건은 FR-OPS-06 수용 기준입니다.
- 배포/스택·기존 스키마·필수 인덱스: `docs/03-trd/TRD.md:39-74`; HTTP routes와 sync 커서: `docs/03-trd/TRD.md:80-139`; 봇 권한·라우트: `docs/03-trd/TRD.md:193-204`; 첨부 계약: `docs/03-trd/TRD.md:214-223`.
- B1–B9, B2 단일 `assertAccess`, commit 후 이벤트, DB 원장, 본문 지속 캐시 금지, Redis 금지: `CLAUDE.md:31-52`. 상세 접근 가드는 `apps/server/src/http/access.ts:35-42,96-100`; `assertAccess` 단일 진입점은 `apps/server/src/modules/conversations/service.ts:16-26,52-60`.
- 현재 첨부 테이블/제한: `apps/server/migrations/0003_attachments.sql:5-36`; 사람·봇 공용 업로드 처리, no-store·nosniff 다운로드 응답: `apps/server/src/modules/attachments/routes.ts:14-20,54-68,94-110`.
- WebSocket은 메모리 연결 집합, 전달 최적화이며 실패 시 REST catch-up: `apps/server/src/modules/realtime/hub.ts:102-104,165-173`; TRD `:137-139`.
- PostgreSQL 공식 문서: [Text Search Configuration](https://www.postgresql.org/docs/current/textsearch-configuration.html)는 parser와 dictionary가 토큰을 lexeme으로 바꾼다고 설명하고, [Preferred Index Types for Text Search](https://www.postgresql.org/docs/16/textsearch-indexes.html)는 자주 검색되는 `tsvector` 컬럼에 GIN 인덱스를 권장합니다. 따라서 한국어 검색은 인덱스만 추가해서 해결되지 않으며 실제 한국어 토큰 분석 품질과 운영 설치 환경 검증이 별도 필요합니다.

## 사실 / 추정 / 확인 필요

- **사실:** P0 42개가 구현됐다는 것은 브리프의 보고이며, 본 검토에서는 코드를 실행하거나 QA를 재수행하지 않았습니다. TRD에는 검색/presence가 MVP에서 제외됐고, 전환 관찰은 11-10–11-16, G1은 미통과로 기록돼 있습니다.
- **설계 추정:** 검색은 메시지 본문을 별도 복제하지 않는 것이 B7/삭제 수명주기와 잘 맞습니다. 단 한국어 검색이 요구하는 형태소/부분어 동작은 PostgreSQL 버전·허용 확장·합성 데이터로 비교해 정해야 합니다. GIN 쓰기 비용과 크기는 실제 데이터 규모 미측정입니다.
- **설계 추정:** Redis 없이 presence/typing은 단일 앱 프로세스의 휘발성 메모리와 WS TTL로 제공할 수 있습니다. 재시작 후 상태 복원, 다중 프로세스 동기화, 백그라운드 PWA 실시간 수신은 약속할 수 없습니다.
- **확인 필요:** PostgreSQL 운영 버전·서버 extension 설치 권한, 예상 메시지량/첨부 상한과 보존, 실제 검색 용어 샘플(비밀 없는 합성 코퍼스), Hermes에서 필요한 문서 MIME/최대 크기·clarify 상호작용, 버튼 승인 action 수명주기, 채널 봇 초대 UX, G1 및 전환 QA 결과.

## 요구사항·결정 후보

1. 관찰 창 동안에는 요구사항·보안 경계·합성 한국어 검색 평가 계획만 작성하고 Hermes 어댑터 및 Push 코드를 동결할지 결정해 주십시오.
2. 11-17 이후에도 G1 통과를 구현 착수 게이트로 둘지 결정해 주십시오.
3. G1 통과 후 1차 묶음을 세 후보 이하로 제한하고, 개인 Jarvis 흐름에서 확인된 사용 빈도로 최종 선택해 주십시오.
4. 검색은 운영 PostgreSQL에서 추가 언어 확장 설치 없이 구현 가능한지 먼저 검증할지 결정해 주십시오.
5. 버튼형 승인은 만료·단회 nonce·owner/스레드 바인딩을 포함한 위협 검토와 함께 별도 승인할지 결정해 주십시오.

**공통 질문 — 전환 관찰 창(11-10–11-16) 동안 착수해도 되는 항목은 무엇인가?** 권고 답은 문서/합성 데이터 평가만이며, 실제 Hermes/Push 경로 변경은 11-17 이후 판정과 G1 완료 뒤입니다.
