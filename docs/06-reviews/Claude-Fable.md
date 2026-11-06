# R2 상호 평가 — Claude-Fable

- 상태: R2 리뷰 / 작성자: Claude-Fable (pubkey `2f4fc939…`) / 작성일: 2026-11-07
- 대상: `docs/02-prd/PRD.md`(GPT-Sol R1 v1.1), `docs/03-trd/TRD.md`(GPT-Luna R1), `docs/04-dev-design/DEV_DESIGN.md`(Claude-Opus R1). 제 문서 `docs/05-design-ref/DESIGN_REFERENCE.md`는 대상이 아니며, 대조용으로만 인용합니다.
- 방법: 세 문서와 `CLEANROOM.md`·브리프 0절을 전부 읽고 줄 번호로 대조했습니다. 다른 리뷰어의 R2 파일은 읽지 않고 독립적으로 썼습니다(합류 여부는 Jarvis가 비교). 코드·설치·Git·DB·`.env`·shared-infra는 건드리지 않았고 외부 사이트도 조회하지 않았습니다.
- 관점: 디자인 레퍼런스 담당이므로 **UI가 실제로 그릴 수 있는 계약인가**(데이터가 API·이벤트로 오는가, 상태가 정의돼 있는가)를 중점으로 봤습니다. 확정 결정(브리프 0절)은 반박하지 않습니다.
- 표기: **사실** = 인용한 줄에 그렇게 적혀 있음 / **추정** = 제 설계 판단 / **확인 필요** = 이 세션에서 검증 못 함.

## 0. 점수 요약

| 문서 | 정확성 | 완결성 | 문서 간 정합성 | 구현 가능성 | Must-fix | Should-fix |
|---|---|---|---|---|---|---|
| PRD (GPT-Sol) | 4 | 4 | 4 | 4 | 3 | 5 |
| TRD (GPT-Luna) | 3 | 3 | 3 | 3 | 7 | 8 |
| 개발설계서 (Claude-Opus 5.5) | 4 | 4 | 4 | 4 | 5 | 5 |

한 줄 결론: **PRD와 개발설계서는 R3에서 소폭 수정으로 채택 가능합니다. TRD는 P0 라우트 누락·커서 범위 모순·삭제 본문 재생 누출 세 가지가 해결되기 전에는 개발설계서 W-05~W-09가 착수할 수 없습니다.**

---

## 1. PRD — `docs/02-prd/PRD.md` (GPT-Sol)

### 1-1. 점수 근거
- 정확성 4: 확정 결정과 FR이 어긋나는 곳이 없습니다. 수용 기준이 수치·조건으로 적혀 테스트로 옮길 수 있습니다.
- 완결성 4: 스레드 unread의 **대상 범위**와 수치 상한이 비어 있습니다(아래 Must-fix).
- 정합성 4: 640px 가정(102행)을 디자인 레퍼런스가 받았고, 계측 표(142행)는 TRD와 필드명이 한 곳 다릅니다.
- 구현 가능성 4: FR-MSG-04와 FR-MSG-06의 상호작용(답글이 seq를 소비하는가)이 정해지지 않아 페이지 테스트가 두 가지로 해석됩니다.

### 1-2. Must-fix

| # | 근거 | 문제 | 제안 수정 |
|---|---|---|---|
| P-1 | `docs/02-prd/PRD.md:91` (FR-SYNC-03 "스레드는 답글만 별도 집계"), `:46` (S6), `:92` (FR-SYNC-04 배지) | **어느 스레드의 답글을 unread로 세는지 정의가 없습니다.** 모든 스레드를 세면 참여하지 않은 스레드까지 배지가 뜨고, 아무 것도 안 세면 S4 "스레드에서 멘션을 받고"의 읽음 해제가 모호합니다. 사이드바 숫자 배지(디자인 CMP-04)와 스레드 요약의 "새 답글" 점(CMP-14)이 무엇을 보여줄지 결정할 수 없습니다. | FR-SYNC-03 수용 기준에 한 문장 추가: "스레드 unread 대상은 **내가 원문을 썼거나, 답글을 썼거나, 멘션된 스레드**로 한정한다(추정·제안). 스레드 unread는 대화 숫자 배지에 **합산하지 않고** 별도 표시(점 또는 '새 답글')로 노출한다." 표시 방식은 디자인 레퍼런스 §6-2가 받습니다. |
| P-2 | `:59` (FR-AUTH-06 "수치·방식 TRD 가정"), `:75` (FR-MSG-01 "상한 TRD 합의") | 수치를 TRD에 넘겼는데 TRD R1(`docs/03-trd/TRD.md:105`)도 수치를 적지 않았습니다. 결과적으로 **아무 문서도 상한을 소유하지 않아** 개발설계서 FR-AUTH-06·FR-MSG-01 테스트(`DEV_DESIGN.md:195`, `:200`)를 쓸 수 없습니다. | PRD가 "TRD 확정 전 제안값"을 수용 기준에 명시: 로그인 제한 예 "같은 계정 또는 같은 출처에서 15분 10회 초과 시 15분 차단"(제안값), 본문 상한 예 "4,000자(문자 수 기준은 TRD)"(제안값). TRD가 바꾸면 PRD 변경 이력에 기록. 수치 자체는 영환님 결정 후보입니다. |
| P-3 | `:78` (FR-MSG-04 "1만 건 합성 이력 … 이전 페이지"), `:80` (FR-MSG-06 "답글은 본문에 중복 표시하지 않음") | 답글이 대화 `seq`를 소비하는지, 본문 이력 페이지에 답글이 포함되는지가 적혀 있지 않습니다. TRD(`TRD.md:52`)는 답글도 같은 `messages`·같은 `seq`라서, 50건 페이지에 답글 40건이 섞이면 화면에 10건만 보입니다. 페이지 경계 테스트(FR-MSG-04)가 두 가지로 해석됩니다. | FR-MSG-04 수용 기준에 추가: "본문 이력 조회는 **원문만** 반환하고 답글은 스레드 조회로 분리한다. `seq`는 대화 단위로 공유한다(답글도 소비)." 그러면 "삭제는 순서 자리 유지"와도 충돌하지 않습니다. 라우트는 TRD(T-3)에서 추가. |

### 1-3. Should-fix

| # | 근거 | 문제 | 제안 |
|---|---|---|---|
| P-4 | `:101`–`:102` | 데스크톱 3단과 ≤640px 1단만 있고 **641–1023px**(iPad 세로·좁은 창)은 어느 FR도 다루지 않습니다. 디자인 레퍼런스 §5-1(`DESIGN_REFERENCE.md:213`–`215`)은 2단을 정의했습니다. | FR-CLIENT-02 수용 기준에 "641px 이상 레이아웃 단수는 디자인 레퍼런스 §5-1을 따른다"를 추가하거나, FR-CLIENT-01을 "≥1024px 3단"으로 한정. |
| P-5 | `:75` | "안전한 링크"의 정의가 없습니다. | 허용 스킴 allowlist(`http`·`https`·`mailto`) 명시, 그 외는 일반 텍스트로 표시. 디자인 CMP-08(`DESIGN_REFERENCE.md:280`)과 같은 규칙. |
| P-6 | `:142` vs `docs/03-trd/TRD.md:142` | 계측 필드명 `duration_ms bucket`(PRD) vs `latency bucket`(TRD). | 한쪽으로 통일(PRD 정본 권고, TRD가 따름). |
| P-7 | `:95` (FR-SYNC-07 "재인증") , `:158` (⚖️-1) | 세션 수명·연장 방식이 없어 "5분 백그라운드 후 재인증"이 **매번 로그인**인지 **쿠키 유효 확인**인지 모릅니다. iOS 홈 화면 PWA는 비밀번호 재입력 UX 비용이 큽니다. | ⚖️-1에 "세션 수명·슬라이딩 연장 여부"를 추가하고, R1 권고로 "슬라이딩 연장, 수명은 TRD 수치"를 적습니다. |
| P-8 | `:103` (FR-CLIENT-03) | iOS 홈 화면 PWA는 Safari와 저장소(쿠키 포함)가 분리될 수 있어 "설치 후 standalone 실행"이 **로그인 상태를 잃을 수 있습니다**(확인 필요 — 이 세션에서 Apple 문서 미확인). | 수용 기준에 "standalone 첫 실행 시 로그인 화면이 나와도 실패로 보지 않고, standalone 안에서 로그인 후 재실행 유지"를 추가. |

### 1-4. 동의하는 강점
1. **모든 P0 수용 기준이 수치·상태·금지 조건으로 적혀** 있어 개발설계서가 1:1 테스트 이름으로 바로 옮길 수 있었습니다(`:54`–`:116`). 특히 FR-SYNC-06 "커서 후퇴·배지 재증가 없음"(`:94`)과 FR-CLIENT-04 "SW/Cache Storage/IndexedDB/localStorage 미보관"(`:104`)은 그대로 테스트 단언문입니다.
2. **계측 허용 목록(10절)** 이 enum·구간값만 허용하고 식별자 해시까지 금지한 점(`:138`)은 개인 전용 제품에서도 좋은 기본값입니다.

---

## 2. TRD — `docs/03-trd/TRD.md` (GPT-Luna)

### 2-1. 점수 근거
- 정확성 3: 데이터 모델은 커서를 **대화별**로 두었는데(`:50`, `:53`, `:88`) 복구 API는 **단일 커서**를 받습니다(`:75`). 문서 안에서 모순입니다.
- 완결성 3: P0 FR 중 채널 생성·참여·나가기·DM 시작·비활성화·멤버 목록·답글 조회 라우트가 없습니다(`:66`–`:78`). 수치(상한·제한·보존 기간)가 없습니다.
- 정합성 3: `read.updated`에 `thread_root_id`가 없어 PRD FR-SYNC-03 분리 커서와 맞지 않습니다(`:92`). PWA 아이콘 세트가 디자인 레퍼런스와 다릅니다(`:127`).
- 구현 가능성 3: 위 세 가지가 해결되면 4입니다. 트랜잭션 설계(`:58`)와 보안 원칙(`:100`–`:106`)은 그대로 구현할 수 있습니다.

### 2-2. Must-fix

| # | 근거 | 문제 | 제안 수정 |
|---|---|---|---|
| T-1 | `docs/03-trd/TRD.md:50` (`conversations.last_sync_cursor`), `:53` (`unique(conversation_id, sync_cursor)`), `:88` (`conversation.subscribe … after_cursor`) **vs** `:75` (`GET /api/sync?since={cursor}` 단일 값), `:96` | **변경 커서의 범위가 모순입니다.** 모델은 대화별 커서인데 `/api/sync`는 커서 하나를 받습니다. 대화별이면 전경 복귀마다 참여 대화 수만큼 호출해야 하고, 클라이언트가 커서 N개를 보관해야 합니다. 개발설계서(`DEV_DESIGN.md:83`, `:271`)와 디자인 레퍼런스 CMP-15 "최신 상태 확인 중…"(`DESIGN_REFERENCE.md:314`)은 모두 **호출 1회**를 가정했습니다. | **계정 전역 커서**로 통일(추정·권고): `conversation_changes.change_id bigserial PK`(전역 단조), `GET /api/sync?since=<change_id>`는 세션 사용자의 **현재 멤버십** 대화만 필터해 재생. `conversations.last_sync_cursor`와 `subscribe.after_cursor`는 삭제. 대화별 커서를 유지하려면 `/api/sync`가 `{conversation_id: cursor}` 맵을 받도록 바꾸고 그 비용을 명시. |
| T-2 | `:53` (`snapshot`), `:75` ("변경을 cursor 순으로 재생"), `:60` ("복구 응답은 삭제 본문과 mention을 내보내지 않습니다") | **수정 이력 snapshot에 본문이 남습니다.** 수정(snapshot=새 본문) → 삭제 후 복귀 기기가 cursor 순으로 재생하면 `edit` 행의 본문이 먼저 내려가고 `delete`가 뒤따릅니다. 60행의 의도는 맞지만 **그것을 보장하는 규칙이 없습니다.** FR-MSG-05 "삭제 본문·기존 멘션은 조회·복구 응답에서 제거" 위반 경로입니다. | `/api/sync` 응답은 변경 로그를 그대로 재생하지 않고 **메시지 현재 상태로 접어(compact) 반환**: `messages`와 join해 `deleted_at`이 있으면 본문·멘션 없는 tombstone 1건만 보냅니다. `snapshot`은 본문을 담지 않거나(메시지 id·op·seq만), 삭제 시 같은 트랜잭션에서 해당 메시지의 과거 snapshot을 NULL로 갱신. 둘 중 하나를 "계약"으로 적습니다. |
| T-3 | `:66`–`:78` (HTTP 표 전체) | **P0 FR을 만족시킬 라우트가 없습니다.** FR-CONV-01 채널 생성, FR-CONV-02 참여·나가기, FR-CONV-03 DM 시작, FR-AUTH-03 멤버 비활성화, FR-MSG-07 멘션 피커용 **참여자 목록**(디자인 CMP-12 `DESIGN_REFERENCE.md:284`), FR-MSG-06 **답글 목록**(CMP-13 `:285`). `GET /api/conversations`(`:71`)만으로는 사이드바 외 어떤 화면도 데이터를 받지 못합니다. | 추가 제안(이름은 가정): `POST /api/conversations {kind:"channel", name}` · `POST /api/conversations/{id}/join` · `POST /api/conversations/{id}/leave` · `POST /api/conversations/dm {user_id}` · `GET /api/conversations/{id}/members` · `GET /api/messages/{root_id}/replies?after_seq=&limit=` · `POST /api/admin/members/{user_id}/deactivate`. 모두 `assertAccess` 또는 관리자 가드를 통과. |
| T-4 | `:92` (`read.updated: conversation_id, last_read_seq`) **vs** `:76` (`PUT /api/read-state … thread_root_id?`), `:55` (`thread_read_state`) | 저장은 스레드별로 하는데 **이벤트에는 `thread_root_id`가 없어** 다른 기기가 스레드 읽음을 반영할 수 없습니다. FR-SYNC-03·04 위반이고, 디자인 CMP-14 "새 답글" 해제(`DESIGN_REFERENCE.md:286`)가 실시간으로 꺼지지 않습니다. | `read.updated` 필드에 `thread_root_id?`(null이면 대화 본문) 추가. |
| T-5 | `:71` (`GET /api/conversations` 목록만), `:77` (`GET /api/conversations/{id}/unread` 대화별) | **사이드바 초기 로드가 N+1 호출**입니다. 대화 10개면 배지를 그리기 위해 11번 호출하고, 전경 복귀마다 반복됩니다. FR-SYNC-04 "2초 내 일치"와 FR-SYNC-07 "100건+읽음 동기화 완료 후 최신 표시"를 모바일에서 맞추기 어렵습니다(추정). | `GET /api/conversations` 각 항목에 `last_seq, last_read_seq, unread_count, mention_count, has_unread_thread_reply`를 포함(또는 `GET /api/unread` 벌크 1개). `GET /api/conversations/{id}/unread`는 유지해도 됩니다. |
| T-6 | `:105` ("길이/frame 상한, 로그인 rate limit"), `:75` ("만료 cursor는 410"), `:101` (`expires_at`) | **수치가 하나도 없습니다.** 본문 상한, WS 프레임 상한, 로그인 제한, 세션 수명, **변경 로그 보존 기간**(언제 410이 되는가). 보존 기간이 없으면 410 분기와 "전체 snapshot 요구"를 테스트할 수 없고, 클라이언트가 언제 전체 재동기화 UI(디자인 §6-4 "최신 상태 확인 중…")를 띄울지 정할 수 없습니다. | 각 항목에 "제안값(영환님 확정)"을 적습니다. 예: 본문 4,000자·프레임 64KiB·로그인 15분 10회·세션 30일 슬라이딩·변경 로그 30일 보존 또는 10만 건 중 먼저 도달(모두 추정·제안). 값보다 **소유 문서가 TRD임을 명시**하는 것이 핵심입니다(PRD P-2와 짝). |
| T-7 | `:89` (`message.created … message{id,seq,author_id,thread_root_id,body,created_at}`), `:90` (`message.updated`), `:56` (`message_mentions`) | **이벤트·이력 응답에 멘션 ID 배열이 없습니다.** PRD FR-MSG-07은 멘션을 **멤버 ID 기반**으로 정의했고 "수정 시 추가/제거 반영"을 요구합니다. 클라이언트가 본문을 파싱해 멘션을 추론하면 ID 기반 규칙과 어긋나고, 자기 멘션 하이라이트(디자인 §6-3 `DESIGN_REFERENCE.md:305`)의 데이터원이 없습니다. | `message{…}`와 `message.updated`, `GET …/messages` 응답에 `mention_user_ids: uuid[]` 추가. 본문 안 표기(`@이름`)는 표시용이고 집계는 이 배열로. |

### 2-3. Should-fix

| # | 근거 | 문제 | 제안 |
|---|---|---|---|
| T-8 | `:80` ("404 접근 불가 리소스(존재 은폐)") vs `PRD.md:79` (FR-MSG-05 "타인 요청 403"), `PRD.md:58` (FR-AUTH-05 403) | 403/404 규칙이 한 줄로만 있어 **멤버이지만 작성자가 아닌 경우**와 **비멤버**가 구분되지 않습니다. | 표로 고정: 비멤버의 대화 단위 자원 → 404 / 멤버이나 작성자 아님(수정·삭제) → 403 / 일반 멤버의 관리자 API → 403 / 비활성 계정 → 401. 개발설계서 FR-CONV-04 매트릭스가 이 표를 기대값으로 씁니다. |
| T-9 | `:52` (`thread_root_id`) | "답글의 답글 거부"(FR-MSG-06)를 보장하는 제약이 없습니다. | 서비스 규칙 + DB `CHECK`(root의 `thread_root_id IS NULL`)를 계약으로 명시. 트리거 또는 삽입 시 root 조회로 검증. |
| T-10 | `:46` (`users.status`), `:47` (`workspace_members.status`) | 비활성화가 어느 `status`를 바꾸는지 모호합니다. 단일 워크스페이스에서 둘은 중복입니다. | 하나만 두거나(권고: `users.status`), `workspace_members.status`는 P1(복수 워크스페이스 없음)로 제거. |
| T-11 | `:102` ("session-bound CSRF custom header") | 세션 결합 토큰을 **어디서 발급·수신**하는지 없습니다. | `GET /api/me` 응답에 `csrf_token` 포함, 상태 변경 요청은 `X-CSRF-Token` 헤더로 반송. 또는 "임의 커스텀 헤더 존재 + 정확한 Origin"의 더 단순한 안을 택하고 근거 명시. |
| T-12 | `:72` (`before_seq`만) | 읽음 커서 위치에서 **앞으로** 읽기(새 메시지 구분선으로 점프, 디자인 §4-2 `#m-:seq` `DESIGN_REFERENCE.md:189`)가 불가능합니다. | `after_seq=` 또는 `around_seq=` 파라미터 추가. P-3 반영 시 `roots_only=true` 기본. |
| T-13 | `:127` ("독자 제작 192/512 아이콘") | 디자인 레퍼런스 §9-2(`DESIGN_REFERENCE.md:407`–`413`)는 `maskable`·`monochrome`·`apple-touch-icon 180`을 추가로 요구합니다. iOS 홈 화면 추가(FR-CLIENT-03)는 `apple-touch-icon`이 없으면 스크린샷 썸네일이 쓰입니다(추정). | TRD 6절 아이콘 문장을 "디자인 레퍼런스 §9-2 세트"로 참조. |
| T-14 | `:35` (Node 버전 "착수 시 고정") vs `DEV_DESIGN.md:241` (R-10 "TRD가 결정") | 양쪽이 서로에게 넘겨 **아직 아무도 결정하지 않았습니다.** | TRD가 "Node 26 LTS 최신 패치(설치된 26.12.1 포함), 착수 시 nodejs.org 릴리스 표로 LTS 상태 확인"처럼 **범위와 확인 절차**를 지금 적습니다(확인 필요: 26.x의 LTS 전환 시점은 이 세션에서 조회하지 않음). |
| T-15 | `:41` ("FK/delete 동작은 명시합니다") | 표에 FK 동작이 없습니다. | 각 FK에 `ON DELETE RESTRICT`(기본) 또는 `CASCADE` 명시. 특히 `messages.thread_root_id`는 RESTRICT(원문 삭제는 tombstone이라 물리 삭제 없음). |

### 2-4. 동의하는 강점
1. **`seq`(정렬)와 `sync_cursor`(변경 복구)의 분리**(`:58`)와 "저장 ACK·WS는 commit 후"(`:58`, `:96`)는 FR-MSG-02·FR-SYNC-02의 뼈대이며, 개발설계서 B3·B4와 정확히 맞물립니다.
2. **읽음 커서 `max(current, request)` 단조 병합**(`:60`)과 **토큰 원문 미저장·존재 은폐 404**(`:48`, `:49`, `:80`)는 짧은 문장으로 보안 요구를 정확히 담았습니다.

---

## 3. 개발설계서 — `docs/04-dev-design/DEV_DESIGN.md` (Claude-Opus 5.5)

### 3-1. 점수 근거
- 정확성 4: 전역 규칙(Playwright 금지·커버리지 80%·Red-Green)과 CLEANROOM 인용이 모두 맞습니다. 33=33 매핑도 PRD P0 행 수와 일치합니다(제가 PRD 표에서 다시 셌습니다: AUTH 5·CONV 4·MSG 8·SYNC 7·CLIENT 5·OPS 4).
- 완결성 4: 디자인 에셋 생산(앱 심볼·아이콘 세트·폰트 서브셋)이 WBS에 없고, `check:no-persist-cache`의 동작 정의가 없습니다.
- 정합성 4: 단일 커서·403 가정은 TRD 결론을 따르면 되는 R3 항목입니다.
- 구현 가능성 4: 접근 매트릭스 자동 수집 규칙이 `:conversationId` 라우트만 잡아 메시지 ID 라우트를 놓칩니다(아래 D-5).

### 3-2. Must-fix

| # | 근거 | 문제 | 제안 수정 |
|---|---|---|---|
| D-1 | `docs/04-dev-design/DEV_DESIGN.md:216` (FR-CLIENT-02 "640px 이하에서 … 1단"; QA 320·390·640) , `:215` (FR-CLIENT-01 키보드만) | **641px 이상 레이아웃은 어떤 테스트도 보지 않습니다.** FR-CLIENT-01의 "3단"은 키보드 테스트만 있고 단수 전환은 검사하지 않으며, 디자인 §5-1의 2단(641–1023)은 자동·수동 모두 없습니다. 3단이 깨져도 G1을 통과합니다. | `responsive.test.tsx`를 **3구간**(`≤640`·`641–1023`·`≥1024`)의 `matchMedia`로 확장하고, `QA-FR-CLIENT-02` 폭에 768·1024·1440을 추가(디자인 §11-1 `DESIGN_REFERENCE.md:457`). FR-CLIENT-01 지정 테스트 이름에 "≥1024px에서 3단"을 포함. |
| D-2 | `:207` (FR-MSG-08 `composer-ime.test.tsx` "`isComposing`·keyCode 229 이벤트") | **Safari의 실제 실패 경로가 테스트에 없습니다.** 조합 확정 Enter에서 Safari가 `compositionend` 직후 `isComposing=false`인 `keydown Enter`를 보내는 경로(디자인 §7-4-3 `DESIGN_REFERENCE.md:365`, 추정)는 두 조건으로 잡히지 않습니다. 이 경로가 "한글 마지막 글자 치고 Enter → 조각 전송" 버그의 본체입니다. | 지정 테스트에 세 번째 케이스 "`compositionend` 직후 같은 틱의 Enter는 전송하지 않고, 다음 Enter만 전송"을 추가. jsdom에서 `compositionend` → `keydown(Enter, isComposing:false)` 순서로 재현 가능합니다. |
| D-3 | `:112` (W-02 `check:no-persist-cache`), `:218` (FR-CLIENT-04 행) | 게이트 스크립트인데 **무엇을 어떻게 검사하는지 정의가 없습니다.** 런타임 저장소 검사는 브라우저 없이 불가능하고(Playwright 금지), 현재 설계로는 구현자가 임의로 해석합니다. | 정의 제안: ① eslint `no-restricted-globals`/`no-restricted-properties`로 `localStorage`·`sessionStorage`·`indexedDB`·`caches`를 `apps/web/src/features/pwa/sw.ts` 밖에서 금지 ② SW 라우팅 단위 테스트에서 `/api/**`·WS 요청이 `fetch` 패스스루인지 단언 ③ 실기 저장소 검사는 `QA-FR-CLIENT-04`로 유지. 스크립트는 ①·②를 묶어 실행. |
| D-4 | `:114` (W-04 Designer 완료 조건), `:121` (W-11 "manifest·아이콘·SW") | **아이콘·폰트 에셋을 만드는 작업이 없습니다.** W-04는 상태표·키보드·브레이크포인트만 산출하고, W-11은 "아이콘"을 소비합니다. 디자인 §9(`DESIGN_REFERENCE.md:401`–`413`)의 독자 심볼 SVG + PNG 4종, §3-2의 Pretendard 서브셋 WOFF2(`:99`)는 누가 언제 만드는지 없어 FR-CLIENT-03이 G1에서 막힙니다. | W-04 완료 조건에 "앱 심볼 `source.svg`·아이콘 세트(any 192/512·maskable 512·monochrome·apple-touch 180)·favicon, PR 본문 '독자 제작' 표기"를 추가하거나 W-04b(Designer, S)를 신설. 폰트 서브셋 빌드는 W-01 또는 W-10 완료 조건에 포함. |
| D-5 | `:72` (B2 "`:conversationId`를 가진 모든 라우트와 WS 구독이 매트릭스에"), `:199` (FR-CONV-04 "라우트 레지스트리에서 대상을 자동 수집") **vs** `TRD.md:74` (`PATCH/DELETE /api/messages/{id}`) | **자동 수집 규칙이 메시지 ID 라우트를 놓칩니다.** 수정·삭제(그리고 T-3의 답글 목록)는 경로에 `:conversationId`가 없어 레지스트리 테스트에 잡히지 않고, `assertAccess`를 빠뜨려도 통과합니다. FR-CONV-04 "수정·삭제·스레드"에 적용이라는 요구와 어긋납니다. | 수집 규칙을 "경로에 `:conversationId` **또는** `:messageId`/`:rootId`가 있는 라우트"로 확장하고, 메시지 ID 라우트는 `messages.service`가 메시지로 대화를 해석해 `assertAccess`를 호출함을 B2에 명시. 레지스트리는 라우트에 `scope: 'conversation' | 'message' | 'admin' | 'public'` 메타를 **필수**로 요구하고, 메타가 없으면 테스트 실패. |

### 3-3. Should-fix

| # | 근거 | 문제 | 제안 |
|---|---|---|---|
| D-6 | `:83`, `:271` (A3 단일 커서), `:84` | TRD T-1 결론에 따라 바뀝니다. | TRD 확정 후 A3·2-3절 갱신(이미 R3 대상으로 표시돼 있음). |
| D-7 | `:112` (W-02), `:223` (QA-FR-OPS-04 "디자인 출처 검토") | 디자인 §2-3-3 색 규칙과 §7-1 대비 4.5:1/3:1은 **토큰 린트**로 자동화할 수 있는데 W-02 스크립트 4종에 없습니다. 수동만으로 두면 다크 모드 토큰 추가 때마다 사람이 다시 봐야 합니다. | `check:design-tokens`(토큰 파일의 `source`·`license` 필수, 면 역할 토큰의 색상 280–330°·명도 ≤35%·채도 ≥40% 금지, 텍스트/배경 쌍 대비 계산)를 W-02에 추가(S). 못 넣으면 QA-FR-OPS-04에 §2-3 체크리스트를 명시적으로 인용. |
| D-8 | `:82` (`{message_id, seq}`) vs `TRD.md:73` (`message_id/seq/sync_cursor`) | 응답 형태가 다릅니다. | TRD 값으로 통일(클라이언트가 전송 직후 커서를 갱신하려면 `sync_cursor`가 필요). |
| D-9 | `:199`, `:194` | FR-CONV-04·FR-AUTH-05 테스트의 **기대 상태 코드**가 적혀 있지 않습니다. T-8 표가 생기면 그대로 인용. | 지정 테스트 이름에 "비멤버 404 / 비작성자 403 / 비관리자 403" 명시. |
| D-10 | `:150` (`check:fr-coverage`가 PRD 마크다운에서 P0 행 추출) | PRD 표 형식 변경(열 추가·굵게 표시)에 깨집니다. 스캐너 오류를 실패로 처리하는 규칙은 좋지만, **PRD 쪽에 "표 형식 변경 금지" 계약**이 없습니다. | PRD 11절 가정 1 또는 변경 이력 규칙에 "FR 표 5열·우선순위 열 위치 고정"을 추가해 양쪽 계약으로. |

### 3-4. 동의하는 강점
1. **접근 검사 단일 진입점 + 라우트 레지스트리 자동 수집 테스트**(`:72`, `:199`)는 "새 라우트가 보안 매트릭스를 빠뜨릴 수 없다"는 구조적 보장입니다(D-5만 보완하면 완성). **테스트 DB `_test` 접미사 강제**(`:149`)도 같은 종류의 구조적 안전장치입니다.
2. **0절 "P0의 두 뜻" 분리**(`:8`–`:15`)와 **테스트 이름에 FR ID + `check:fr-coverage`**(`:20`, `:150`)는 문서 간 드리프트를 사람이 아니라 기계가 잡게 합니다. PRD가 바뀌면 게이트가 깨지는 방향이라 안전합니다.

---

## 4. 문서 간 충돌 목록 (양쪽 file:line)

| # | 항목 | A | B | 정본 제안 |
|---|---|---|---|---|
| X-1 | 변경 커서 범위 | `TRD.md:50`, `:53`, `:88` 대화별 | `TRD.md:75`, `DEV_DESIGN.md:83`, `:271`, `DESIGN_REFERENCE.md:314` 단일 | 계정 전역 커서(T-1). TRD 정본 |
| X-2 | `read.updated` 필드 | `TRD.md:92` `thread_root_id` 없음 | `TRD.md:76` PUT에는 있음; `PRD.md:91` 분리 커서; `DESIGN_REFERENCE.md:286` 스레드 "새 답글" | 필드 추가(T-4) |
| X-3 | 403 vs 404 | `TRD.md:80` 404 은폐 | `PRD.md:58`, `:79` 403; `DEV_DESIGN.md:194`, `:199` 코드 미명시 | T-8 표. TRD 정본, PRD는 "비작성자 403" 유지 |
| X-4 | 브레이크포인트 단수 | `PRD.md:101`–`:102` 3단·≤640 1단만; `DEV_DESIGN.md:216` ≤640만 테스트; `TRD.md:127` "640px 이하 단일 화면" | `DESIGN_REFERENCE.md:213`–`:215` 3구간(641–1023 2단 포함) | 디자인 레퍼런스 §5-1 정본, PRD·DEV가 참조(P-4, D-1) |
| X-5 | 전송 응답 형태 | `DEV_DESIGN.md:82` `{message_id, seq}` | `TRD.md:73` `message_id/seq/sync_cursor` | TRD |
| X-6 | 계측 필드명 | `PRD.md:142` `duration_ms bucket` | `TRD.md:142` `latency bucket` | PRD |
| X-7 | PWA 아이콘 세트 | `TRD.md:127` 192/512 | `DESIGN_REFERENCE.md:407`–`:413` + maskable·monochrome·apple-touch 180 | 디자인 레퍼런스 |
| X-8 | 멘션 데이터원 | `TRD.md:89`–`:90` 이벤트에 멘션 없음 | `PRD.md:81` ID 기반; `DESIGN_REFERENCE.md:305` `message_mentions` 가정 | `mention_user_ids` 배열(T-7). TRD |
| X-9 | 테스트 파일명 | `DEV_DESIGN.md:201` `send-status.test.tsx` | `DESIGN_REFERENCE.md:500` `conversation/send-state` | **제 오기입니다.** R3에서 제 A2를 `send-status`로 고칩니다 |
| X-10 | Node 버전 | 브리프 `BUZZ_ROUND2_DOCS.md:20` 26.12.1 설치 | `TRD.md:35` 미결정; `DEV_DESIGN.md:241` "TRD가 결정" | TRD가 범위·확인 절차 명시(T-14) |
| X-11 | 수치 소유권(본문 상한·로그인 제한·세션 수명·로그 보존) | `PRD.md:59`, `:75` "TRD 합의" | `TRD.md:105` 수치 없음; `DEV_DESIGN.md:195`, `:200` 테스트는 수치 필요 | TRD 소유, PRD에 제안값(P-2, T-6) |
| X-12 | 답글과 본문 이력 | `PRD.md:80` "답글은 본문에 중복 표시 안 함" | `TRD.md:72` 단일 이력 라우트(필터 없음); `DESIGN_REFERENCE.md:278`, `:285` CMP-06/13 분리 가정 | 원문 전용 이력 + 답글 라우트(P-3, T-3) |
| X-13 | 사이드바 배지 데이터 | `DESIGN_REFERENCE.md:275`–`:276` CMP-03/04 전체 대화 배지 | `TRD.md:71` 목록에 집계 없음, `:77` 대화별 호출 | 목록 응답에 집계 포함(T-5) |
| X-14 | 멘션 피커 참여자 목록 | `DESIGN_REFERENCE.md:284` CMP-12 | `TRD.md:66`–`:78` 멤버 라우트 없음 | `GET …/members` 추가(T-3) |
| X-15 | 접근 매트릭스 수집 범위 | `DEV_DESIGN.md:72` `:conversationId` 라우트만 | `TRD.md:74` `/api/messages/{id}` | 수집 규칙 확장(D-5) |
| X-16 | QA 폭 목록 | `DEV_DESIGN.md:216` 320·390·640 | `DESIGN_REFERENCE.md:457` + 768·1024·1440 | 디자인 레퍼런스(D-1) |
| X-17 | 비활성화 대상 필드 | `TRD.md:46` `users.status` | `TRD.md:47` `workspace_members.status` | 하나로(T-10). TRD 내부 |

---

## 5. 제 문서(DESIGN_REFERENCE.md)에 돌아오는 수정 — R3 예고

R2 규칙에 따라 지금은 고치지 않고 적어만 둡니다.
1. §13 A2 테스트 파일명 `send-state` → `send-status`(X-9).
2. §2-3-2 에셋 경로 규칙에 **폰트 파일**(`*.woff2`) 허용 위치 `apps/web/public/fonts/`를 추가(지금은 이미지·오디오만 다룸, D-4와 짝).
3. §6-4 "최신 상태 확인 중…" 조건을 T-1 결론(전역 커서 1회 호출 또는 대화별 N회)에 맞춰 문구 조정.
4. CMP-04/CMP-14에 P-1 결론(스레드 unread 대상·합산 여부)을 반영.
5. 다른 리뷰어가 제 문서에 준 Must-fix는 Jarvis 신호 후 R3에서 처리합니다.

---

## 6. 사실 / 추정 / 확인 필요

- **사실:** 위 모든 인용 줄 번호는 2026-11-07 커밋 `f09aaa8` 기준 파일을 `cat -n`으로 읽은 값입니다. PRD P0 행은 33개로 다시 셌습니다. 이 리뷰는 세 문서와 CLEANROOM.md·브리프만 입력으로 썼고 외부 사이트를 조회하지 않았습니다.
- **추정(제 설계 판단):** 전역 커서 권고(T-1), 스레드 unread 대상 한정(P-1), 모든 제안 수치(P-2·T-6), Safari `compositionend`→Enter 경로(D-2), iOS 홈 화면 PWA 저장소 분리(P-8), `apple-touch-icon` 부재 시 썸네일 대체(T-13).
- **확인 필요:** Node 26.x의 LTS 상태(T-14), iOS 홈 화면 PWA와 Safari의 쿠키 분리 여부(P-8), Safari IME 이벤트 순서의 버전별 차이(D-2) — 모두 실기기 QA 또는 공식 문서 재조회 대상이며 이 세션에서는 확인하지 않았습니다.
- **범위 준수:** `docs/06-reviews/Claude-Fable.md`만 썼습니다. 코드·설치·Git·DB·`.env`·shared-infra 미접촉. 다른 리뷰 파일(GPT-Sol·GPT-Luna·Claude-Opus)은 읽지 않았으므로 지적이 겹치거나 상반될 수 있습니다 — 상반되는 곳은 R3 전에 Jarvis 조정이 필요합니다.
