상태: R2 상호 평가 / 작성자: Claude-Opus 5.5 (pubkey `7484092c…`) / 대상: `docs/02-prd/PRD.md`(GPT-Sol R1 v1.1), `docs/03-trd/TRD.md`(GPT-Luna R1), `docs/05-design-ref/DESIGN_REFERENCE.md`(Claude-Fable R1 v0.1)

# R2 상호 평가 — Claude-Opus 5.5

- 기준: 브리프 `BUZZ_ROUND2_DOCS.md` 0절 확정 결정은 평가 대상에서 뺐습니다. 각 문서는 전문을 읽었고, 인용은 리뷰 시점(2026-11-07) 파일의 `file:line`입니다.
- 이 리뷰는 문서 검토입니다. 코드·설치·Git·DB·`.env`는 건드리지 않았습니다. 외부 사이트는 조회하지 않았습니다. 사실 확인은 저장소 안 파일과 `~/Work/shared-infra/docker-compose.yml`(PostgreSQL 이미지 태그)만 했습니다.
- Must-fix는 "R3에서 반영하거나 근거를 들어 거절해야 하는 것", Should-fix는 "권고"입니다.

## 0. 요약

| 문서 | 정확성 | 완결성 | 문서 간 정합성 | 구현 가능성 | Must-fix |
|---|---|---|---|---|---|
| PRD (GPT-Sol) | 4 | 4 | 4 | 4 | 3 |
| TRD (GPT-Luna) | 3 | 3 | 4 | 3 | 6 |
| 디자인 레퍼런스 (Claude-Fable) | 4 | 5 | 4 | 4 | 3 |

가장 급한 것은 **TRD의 동기화 커서 범위(M-T1)와 변경 로그의 삭제 본문 잔존(M-T2)** 입니다. 둘 다 P0 FR(SYNC-02·07, MSG-05)을 설계 단계에서 깨뜨립니다. 같은 가정을 제 개발설계서도 공유하므로(`DEV_DESIGN.md:83`), R3에서 TRD와 함께 고칩니다.

---

## 1. PRD — GPT-Sol

### 점수

| 항목 | 점수 | 이유 |
|---|---|---|
| 정확성 | 4 | 0절 확정 결정과 모순되는 요구가 없습니다. 개인 1명·합성 A/B/C 구분(`PRD.md:33-34`)이 정확합니다 |
| 완결성 | 4 | P0 33개 수용 기준이 측정 가능하게 쓰였습니다. 다만 스레드 unread 대상(M-P1)과 첫 관리자 생성(M-P2)에 FR이 없습니다 |
| 정합성 | 4 | 우선순위 P0와 단계 P0의 구분(`PRD.md:176`), 문서 간 가정(`PRD.md:172-176`)이 명시적입니다 |
| 구현 가능성 | 4 | 수용 기준이 테스트로 바로 옮겨집니다. 개발설계서 33행 매핑이 그대로 성립했습니다 |

### Must-fix

| # | 근거 | 문제 | 제안 수정 |
|---|---|---|---|
| M-P1 | `PRD.md:91`(FR-SYNC-03), `PRD.md:93`(FR-SYNC-05), `PRD.md:174` | **어떤 스레드가 내 unread에 잡히는지 정의가 없습니다.** "스레드는 답글만 별도 집계"라고만 되어 있습니다. 대화의 모든 스레드 답글을 내 unread로 세면 사이드바 배지 의미가 정해지지 않습니다. 그러면 TRD `thread_read_state`(`TRD.md:55`)가 사용자×모든 스레드 행을 갖게 되고, 디자인 CMP-14 "새 답글"(`DESIGN_REFERENCE.md:286`)의 표시 조건도 정해지지 않습니다 | 수용 기준에 대상을 정의해 주세요. 권고: "내가 원문 작성·답글 작성·멘션받은 스레드만 스레드 unread 대상. 채널 배지(굵게)는 원문만, 스레드 unread는 별도 표시". 그리고 "참여하지 않은 스레드의 새 답글은 채널 unread를 올리지 않음"을 추가합니다 |
| M-P2 | `PRD.md:35`, `PRD.md:158`(⚖️-1) | **첫 관리자 생성에 FR ID가 없습니다.** S1(초대)은 관리자가 있어야 시작되는데, 생성 절차를 검증할 테스트 대상이 없습니다. `check:fr-coverage`로도 잡히지 않습니다 | `FR-AUTH-07 첫 관리자는 로컬 운영 절차(서버 CLI)로만 만들고, 관리자가 이미 있으면 거부한다 / P0` 같은 행을 추가하거나, "운영 런북 항목이며 FR 아님"을 명시해 주세요. 공개 가입 경로가 없다는 것도 수용 기준으로 둡니다 |
| M-P3 | `PRD.md:79`(FR-MSG-05 "타인 요청 403"), `PRD.md:58`, `TRD.md:80`(404 존재 은폐) | **권한 거부 상태 코드가 문서마다 다릅니다.** 비참여자가 DM 메시지 수정을 시도하면 PRD는 403, TRD는 404입니다. 제 테스트 이름(`DEV_DESIGN.md:204`)도 403으로 잡혀 있어 판정이 갈립니다 | 수용 기준을 둘로 나눠 주세요. "대화 참여자가 타인 메시지를 수정·삭제하면 403", "비참여자는 대상 존재 여부와 무관하게 404(FR-CONV-04 존재 은폐)". 관리자 API(FR-AUTH-05)는 403을 유지합니다 |

### Should-fix

1. `PRD.md:101-102` — 641–1023px(좁은 데스크톱 창·iPad) 동작을 정한 FR이 없습니다. 디자인은 2단을 확정 제안했습니다(`DESIGN_REFERENCE.md:214`). FR-CLIENT-01/02 수용 기준에 "641–1023px 2단, 스레드는 오버레이"를 넣거나 지원 범위 밖이라고 적어 주세요.
2. `PRD.md:104`(FR-CLIENT-04) — 로그아웃 후 브라우저 뒤로가기의 back/forward cache가 메모리 화면을 되살릴 수 있습니다. "로그아웃 후 뒤로가기로 본문이 다시 보이지 않음"을 수용 기준에 추가하면 TRD·테스트가 따라갑니다.
3. `PRD.md:55`, `PRD.md:95` — 세션 수명(얼마나 자주 다시 로그인하는가)에 대한 기대치가 없습니다. iPhone PWA 재개(FR-SYNC-07)의 "재인증"이 매번 비밀번호 입력을 뜻하는지 정해 주세요. 수치는 TRD에 위임해도 됩니다.
4. `PRD.md:59`(FR-AUTH-06) — 인증·출처 검증·로그인 제한 세 가지가 한 FR에 묶여 있어 실패 원인 추적이 어렵습니다. 분리는 선택입니다. 유지한다면 수용 기준을 세 항목 번호로 나눠 주세요.

### 동의하는 강점

- 수용 기준의 경계가 정확합니다. 예를 들어 "같은 ID·다른 내용은 충돌"(`PRD.md:77`), "오래된 휴대폰 읽음이 늦게 와도 후퇴 없음"(`PRD.md:94`)은 실제로 버그가 나는 지점을 짚습니다.
- 계측 허용 목록(`PRD.md:138-150`)이 "식별자 해시도 금지"까지 내려가 있습니다. 개인정보 누출 방지를 로거 허용 목록으로 구현할 수 있습니다.

---

## 2. TRD — GPT-Luna

### 점수

| 항목 | 점수 | 이유 |
|---|---|---|
| 정확성 | 3 | 커서 범위 모순(M-T1)과 변경 로그 본문 잔존(M-T2)은 수용 기준을 설계 단계에서 깨뜨립니다 |
| 완결성 | 3 | P0 라우트 일부(채널 생성·참여·나가기·DM 시작·비활성화·멤버 목록)가 빠졌고 DDL에 타입·인덱스가 없습니다. 브리프는 "DDL 수준"을 요구했습니다 |
| 정합성 | 4 | PRD 추가 FR, 개발설계서 이름(`assertAccess`·`/api/sync`·`read.updated`)을 맞췄습니다(`TRD.md:13`, `TRD.md:84`) |
| 구현 가능성 | 3 | 방향은 맞습니다. 다만 위 공백은 구현자가 임의로 정하게 되어 R3 정합이 필요합니다 |

### Must-fix

| # | 근거 | 문제 | 제안 수정 |
|---|---|---|---|
| M-T1 | `TRD.md:53`(`unique(conversation_id,sync_cursor)`), `TRD.md:50`(`conversations.last_sync_cursor`), `TRD.md:75`(`GET /api/sync?since={cursor}`), `TRD.md:88`(`conversation.subscribe after_cursor`) | **변경 커서가 대화별인데 따라잡기 API는 단일 커서를 받습니다.** 대화별 커서 하나로는 여러 대화의 변경을 한 번에 재생할 수 없습니다. 그러면 FR-SYNC-02/07(복귀 후 전체 수렴)을 만족시킬 방법이 정해지지 않습니다. 제 `DEV_DESIGN.md:83`도 같은 단일 커서를 가정했습니다 | 둘 중 하나를 고르세요. (a) **계정 전역 단조 커서**: 전역 시퀀스 1개로 `conversation_changes.change_id bigserial`을 두고, `/api/sync?since=`는 접근 가능한 대화의 변경만 필터합니다. (b) **대화별 커서 맵**: `/api/sync`가 `{conversation_id: cursor}` 맵을 받습니다. 권고는 (a)입니다. 클라이언트 상태가 숫자 1개로 단순해지고, 개인 규모라 전역 시퀀스 경합이 문제되지 않습니다(추정, 미측정). 커서 만료 기준(보관 기간)도 함께 적어 주세요 |
| M-T2 | `TRD.md:53`(`conversation_changes.snapshot`), `TRD.md:60`("복구 응답은 삭제 본문을 내보내지 않음") | **수정 이력 행의 snapshot에 본문이 남습니다.** 메시지를 수정한 뒤 삭제하면, 그 이전 커서부터 재생하는 기기가 과거 edit 행의 본문을 받게 됩니다. PRD FR-MSG-05(`PRD.md:79`)의 "삭제 본문은 복구 응답에서 제거"를 어깁니다 | 변경 로그에는 `message_id`·`op`·커서만 두고 재생 시 `messages`의 **현재 상태**를 조인해 내보내세요. snapshot을 유지한다면 삭제 트랜잭션에서 같은 메시지의 이전 change 행 본문을 지우세요. 테스트: "수정→삭제 후 수정 이전 커서로 sync하면 본문 0건" |
| M-T3 | `TRD.md:66-78` | **P0 FR을 구현할 라우트가 빠져 있습니다:** 채널 생성(FR-CONV-01), 참여·나가기(FR-CONV-02), DM 시작(FR-CONV-03), 멤버 비활성화(FR-AUTH-03), DM 상대·멘션 후보용 멤버 목록(FR-CONV-03·MSG-07), 스레드 답글 목록(FR-MSG-06), 410 이후 받을 snapshot | 라우트 표에 추가해 주세요. 예: `POST /api/conversations`(channel), `POST/DELETE /api/conversations/{id}/membership`, `POST /api/dms {user_id}`, `POST /api/admin/members/{id}/deactivate`, `GET /api/members`, `GET /api/messages/{root_id}/replies?after_seq=`, `GET /api/sync/snapshot` |
| M-T4 | `TRD.md:92`(`read.updated: conversation_id, last_read_seq`), `TRD.md:76`(PUT에는 `thread_root_id?`), `TRD.md:55` | **`read.updated`에 `thread_root_id`가 없습니다.** 다른 기기는 채널 읽음과 스레드 읽음을 구분할 수 없습니다. FR-SYNC-03·04를 함께 만족시키지 못합니다. 또 읽음 변경이 `conversation_changes`에 없어서 단절됐던 기기가 복귀해도 읽음을 따라잡을 경로가 없습니다(FR-SYNC-07 "읽음 동기화 완료 후 최신 표시") | `read.updated`에 `thread_root_id`를 넣어 주세요(null이면 채널). 복귀 경로는 둘 중 하나입니다. ① 읽음 변경도 M-T1 전역 커서에 기록 ② `GET /api/conversations` 응답에 대화·스레드별 읽음 위치와 unread·멘션 수를 포함. 권고는 ②입니다. 사이드바 N+1 요청 문제(`TRD.md:77`)도 함께 해결됩니다 |
| M-T5 | `TRD.md:50`, `PRD.md:65`(FR-CONV-01 "앞뒤 공백 제거 후 동일 이름 중복 거부") | **채널 이름 유일성과 1단 스레드 제약이 DDL에 없습니다.** 경쟁 요청에서 중복 채널이 생길 수 있습니다. `conversations`에는 `workspace_id`도 없습니다 | `unique (workspace_id, lower(btrim(name))) where kind='channel'`, `unique (normalized_pair_key) where kind='dm'`, `conversations.workspace_id` FK를 추가해 주세요. `messages.thread_root_id`는 같은 대화의 원문만 가리키고 원문 자신은 `thread_root_id is null`이어야 한다는 제약을 서비스 검사 + 테스트로 명시해 주세요 |
| M-T6 | `TRD.md:35`, `TRD.md:105`, `TRD.md:101`, `PRD.md:75`(상한 "TRD 합의"), `PRD.md:59`(한도 "TRD 가정"), `DEV_DESIGN.md:241`(R-10, "TRD가 결정") | **다른 두 문서가 TRD에 위임한 수치를 TRD도 정하지 않았습니다.** Node 버전, 메시지 본문 상한, 로그인 제한 수치, 세션 만료, WS frame 상한이 모두 미정입니다. 이대로면 아무 문서도 결정하지 않은 값이 됩니다 | R1 제안값이라도 숫자를 넣어 주세요. 예: 본문 ≤ 4,000자, 로그인 5회/15분/계정+IP, 세션 30일 슬라이딩, WS frame ≤ 64KB, heartbeat 25초. Node는 "설치된 26.12.1을 `engines`·`.nvmrc`에 고정, LTS 여부는 nodejs.org 확인 후" 식으로 결정 주체를 TRD로 확정해 주세요. 위 숫자는 제 제안이며 근거 측정은 없습니다 |

### Should-fix

1. `TRD.md:35`, `TRD.md:152` — "shared-infra PostgreSQL 버전은 착수 전 확인"이라고 했지만 이미 확인 가능한 사실입니다. `~/Work/shared-infra/docker-compose.yml:7`이 `postgres:15-alpine`(digest 고정)입니다. 사실로 적어 주세요. CI 서비스 컨테이너도 15로 맞춥니다(`DEV_DESIGN.md:155`).
2. `TRD.md:41-56` — 브리프가 요구한 "DDL 수준"에 비해 타입·NOT NULL·인덱스가 없습니다. 최소한 `messages (conversation_id, seq)`, `messages (conversation_id, thread_root_id, seq)`, `conversation_changes (change_id)` 인덱스와 `body text not null check (length ≤ 상한)`을 적어 주세요.
3. `TRD.md:46-47` — `users.status`와 `workspace_members.status`가 겹칩니다. 비활성화(FR-AUTH-03)가 어느 쪽을 보는지 하나로 정해 주세요.
4. `TRD.md:89` — `message.created`에 멘션 사용자 배열과 원문의 답글 수 갱신이 없습니다. 디자인의 자기 멘션 하이라이트(`DESIGN_REFERENCE.md:305`)와 ThreadSummary(`DESIGN_REFERENCE.md:286`)가 추가 조회 없이 그릴 수 있게 `mentions: user_id[]`, 답글이면 `root_reply_count`를 넣는 안을 권합니다.
5. `TRD.md:100` — "검증된 password hashing library"를 알고리즘 수준(예: argon2id 또는 scrypt)까지 정해 주세요. Security 리뷰의 기준점이 됩니다.
6. `TRD.md:96` — WS heartbeat·dead connection 판정 주기가 없습니다. iPhone 백그라운드에서 끊긴 연결을 서버가 언제 정리하는지가 FR-AUTH-02/03의 "5초 내 종료"와 별개로 필요합니다.
7. `TRD.md:127` — PWA 아이콘이 192/512뿐입니다. 디자인의 `maskable`·`monochrome`·`apple-touch-icon` 180(`DESIGN_REFERENCE.md:405-413`)을 반영해 주세요.

### 동의하는 강점

- `seq`(정렬)와 `sync_cursor`(변경 복구)를 분리한 판단(`TRD.md:58`)이 맞습니다. PRD가 요구한 수정·삭제 복구의 전제입니다. 위 M-T1은 그 커서의 **범위**만 고치는 것입니다.
- 비참여자에게 404로 존재를 숨기는 규칙(`TRD.md:80`, `TRD.md:104`)은 DM ID 추측 공격에 대한 좋은 기본값입니다. PRD를 이쪽으로 맞추자는 것이 M-P3입니다.

---

## 3. 디자인 레퍼런스 — Claude-Fable

### 점수

| 항목 | 점수 | 이유 |
|---|---|---|
| 정확성 | 4 | 라이선스 원문 확인이 구체적이고 추정은 표시돼 있습니다. 다만 일부 상태 규칙(M-D1·M-D2)이 아키텍처·WCAG와 어긋납니다 |
| 완결성 | 5 | 22개 컴포넌트 상태, 전송·연결 매트릭스, 키맵, IME 규칙, 아이콘 세트, QA 체크리스트까지 갖췄습니다 |
| 정합성 | 4 | 정합 가정 10건(`DESIGN_REFERENCE.md:495-508`)이 PRD·TRD·개발설계서를 정확히 짚습니다 |
| 구현 가능성 | 4 | 토큰·CSS 값이 그대로 구현 가능합니다. 트레이드 드레스 회피를 토큰 린트로 바꾼 것(`:48-56`)이 특히 실행 가능합니다 |

### Must-fix

| # | 근거 | 문제 | 제안 수정 |
|---|---|---|---|
| M-D1 | `DESIGN_REFERENCE.md:312`("다시 연결 중… → 전송 시도 → 즉시 실패") | **WS가 끊겼다고 전송을 실패 처리하면 아키텍처와 어긋납니다.** 전송은 HTTP POST이고 WS는 알림 경로일 뿐입니다(`TRD.md:73`, `TRD.md:96`). 네트워크가 살아 있고 WS만 재연결 중이면 저장이 성공합니다. 그런데 UI가 실패로 그리면 사용자가 재시도하게 되고, FR-MSG-02(`PRD.md:76`)의 "DB 커밋 후 저장 확인"과도 맞지 않습니다 | "다시 연결 중"에서는 HTTP 전송을 그대로 시도하고, **HTTP 응답 결과로만** 전송 중/저장 확인/실패를 정해 주세요. 즉시 실패는 `연결이 끊겼습니다` 상태(`navigator.onLine=false` 또는 HTTP 실패 확인)에서만 적용합니다 |
| M-D2 | `DESIGN_REFERENCE.md:300`(전송 중 "본문 투명도 0.6"), `:314`(stale "본문은 흐리게"), `:324`(muted도 4.5:1) | **투명도를 낮추면 본문 대비가 WCAG 1.4.3 4.5:1 밑으로 떨어질 수 있습니다.** 이 문서 자신의 §7-1 규칙과 충돌하고, FR-CLIENT-07 위반 위험이 있습니다 | 전송 중·stale은 투명도 대신 **텍스트 라벨+아이콘**(이미 있는 "전송 중", "최신 상태 확인 중…")과 `--text-muted` step 11(4.5:1 보장)로 표현해 주세요. 투명도를 남긴다면 "결과 대비 4.5:1 이상을 토큰 린트로 실측"을 조건으로 적어 주세요 |
| M-D3 | `DESIGN_REFERENCE.md:186`(`/invite/:token`), `TRD.md:103`("token은 URL·로그에 두지 않음"), `PRD.md:138-144`(초대 링크 계측 금지), `PRD.md:115`(FR-OPS-03 프록시 로그) | **초대 토큰이 URL 경로에 있으면 Serve·서버 접근 로그, 브라우저 기록, Referer로 새어 나갈 수 있습니다** | 경로 대신 프래그먼트 `/invite#t=<token>`을 써 주세요. 프래그먼트는 HTTP 요청에 실리지 않습니다(MDN URL 문서 기준이며 이번에 재조회하지 않았습니다). 페이지에서 읽어 `POST /api/invites/accept` 본문으로 보낸 뒤 `history.replaceState`로 지웁니다. 초대 페이지에는 `Referrer-Policy: no-referrer`를 둡니다. TRD 라우트 정의와 함께 R3에서 맞춥니다 |

### Should-fix

1. `DESIGN_REFERENCE.md:313` — "보낸 메시지는 저장되지 않았습니다"는 이미 저장 확인된 메시지까지 저장되지 않은 것처럼 읽힙니다. "지금 보내는 메시지는 저장되지 않습니다. 연결되면 다시 시도하세요"처럼 범위를 좁혀 주세요.
2. `DESIGN_REFERENCE.md:347-348` — `Alt+↑/↓` 공간 전환은 작성기 포커스 상태에서 macOS의 Option+화살표(문단 이동)와 겹칩니다. §7-3 결과 포커스가 작성기라 바로 충돌합니다. 작성기 안에서는 비활성화하거나 다른 조합을 써 주세요.
3. `DESIGN_REFERENCE.md:213`, `:218` — "Tailwind `sm`=640px와 같은 값"이지만 의미는 반대입니다. Tailwind `sm`은 640px **이상**에 적용되고, 이 문서의 compact는 640px **이하**입니다. 경계값 640px에서 어느 쪽인지 테스트에 명시해 주세요(현재 정의상 compact).
4. `DESIGN_REFERENCE.md:53` vs `:413` — 이미지 파일 허용 경로가 `apps/web/public/icons/`뿐인데 `favicon.svg`·`favicon.ico` 위치가 정해지지 않았습니다. `public/` 루트에 두면 §2-3-2 검사에 걸립니다. 허용 경로에 favicon을 추가하거나 위치를 `icons/`로 정해 주세요.
5. `DESIGN_REFERENCE.md:500` — 테스트 파일명 `conversation/send-state`와 개발설계서 `conversation/send-status.test.tsx`(`DEV_DESIGN.md:201`)가 다릅니다. 제가 R3에서 디자인 쪽 이름(`send-state`)으로 맞추겠습니다. 이 항목은 기록용입니다.

### 동의하는 강점

- 트레이드 드레스 회피를 "하지 마라"가 아니라 **검사 가능한 규칙**(색상 280–330° 면 금지, manifest 금지어, 이미지 경로 제한, `:52-56`)으로 바꿨습니다. CLEANROOM 5절 문자열 검사가 못 잡는 영역을 메웁니다.
- 전송 상태 5종·연결 상태 4종을 **문구까지 정본**으로 둔 것(`:296-314`)은 FR-MSG-02·SYNC-07·CLIENT-07을 한 표로 테스트할 수 있게 해 줍니다.

---

## 4. 문서 간 충돌 목록

"정본 제안" 열은 R3에서 어느 문서를 기준으로 맞출지에 대한 제 권고입니다.

| # | 영역 | 문서 A (file:line) | 문서 B (file:line) | 불일치 | 정본 제안 |
|---|---|---|---|---|---|
| X1 | 동기화 커서 범위 | `TRD.md:53` 대화별 `sync_cursor` | `TRD.md:75` 단일 `since`, `DEV_DESIGN.md:83` 단일 커서 | 대화별 커서 vs 단일 커서 | TRD M-T1 (a) 전역 커서 → 개발설계서 따라감 |
| X2 | 권한 거부 코드 | `PRD.md:79` 타인 403, `DEV_DESIGN.md:204` 403 | `TRD.md:80` 404 존재 은폐 | 비참여자 응답 코드 | 참여자=403, 비참여자=404 (M-P3) |
| X3 | `read.updated` 필드 | `TRD.md:92` `conversation_id, last_read_seq` | `TRD.md:76` PUT `thread_root_id?`, `DEV_DESIGN.md:84`, `DEV_DESIGN.md:211` | 스레드 구분 필드 누락 | TRD에 `thread_root_id` 추가 (M-T4) |
| X4 | 브레이크포인트 | `DESIGN_REFERENCE.md:211-215` 3구간(compact/medium/wide) | `PRD.md:101-102` 3단·≤640 1단만, `DEV_DESIGN.md:216` ≤640 테스트만 | 641–1023 2단의 요구·테스트 부재 | 디자인 정본 → PRD 수용 기준·개발설계서 테스트 추가 |
| X5 | 자기 멘션 데이터원 | `DESIGN_REFERENCE.md:305`, `:506` `message_mentions` 사용 | `TRD.md:89` `message.created`에 멘션 없음 | 이벤트에 멘션 배열 없음 | TRD 이벤트에 `mentions` 추가 (TRD Should-fix 4) |
| X6 | 초대 토큰 위치 | `DESIGN_REFERENCE.md:186` `/invite/:token` | `TRD.md:103` 토큰 URL 금지, `PRD.md:115` 프록시 로그 0건 | 경로 토큰 노출 | 프래그먼트 방식 (M-D3) |
| X7 | PWA 아이콘 세트 | `DESIGN_REFERENCE.md:405-413` any·maskable·monochrome·apple-touch 180 | `TRD.md:127` 192/512만 | 아이콘 종류 | 디자인 정본 |
| X8 | 사이드바 unread 조회 | `DESIGN_REFERENCE.md:275-276` 목록 전체 배지 | `TRD.md:77` 대화별 `/unread` 엔드포인트 | 목록 N+1 | `GET /api/conversations`에 집계 포함 (M-T4 ②) |
| X9 | WS 재연결 중 전송 | `DESIGN_REFERENCE.md:312` 즉시 실패 | `TRD.md:73`·`:96` HTTP 전송은 WS와 독립, `PRD.md:76` 오프라인만 실패 | 실패 판정 기준 | HTTP 결과 기준 (M-D1) |
| X10 | 위임된 수치 | `PRD.md:75` 본문 상한, `PRD.md:59` 로그인 한도, `DEV_DESIGN.md:241` Node 버전, `DESIGN_REFERENCE.md:283` 상한 초과 경고 | `TRD.md:35`·`:105` 미정 | 결정 주체 공백 | TRD가 R3에서 숫자 확정 (M-T6) |
| X11 | PostgreSQL 버전 | `DEV_DESIGN.md:155` 15 | `TRD.md:35` "착수 전 확인" | 사실 vs 미확인 | 15 (shared-infra compose 7행) |
| X12 | 테이블명 | `DEV_DESIGN.md:270` 일반명(대화·멤버십·읽음 상태) | `TRD.md:43-56` `conversations`·`conversation_members`·`conversation_read_state`·`thread_read_state`·`conversation_changes` | 이름 미확정 | TRD 이름이 정본, 개발설계서 R3에서 반영 |
| X13 | 테스트 파일명 | `DEV_DESIGN.md:201` `send-status.test.tsx` | `DESIGN_REFERENCE.md:500` `send-state` | 파일명 | 디자인 쪽으로 (제가 R3에서 수정) |
| X14 | Esc 포커스 복귀 대상 | `PRD.md:107` "원래 항목" | `DESIGN_REFERENCE.md:351` 원문의 "답글" 버튼 | 표현 | 디자인이 구체화, PRD 문구를 맞춤 |
| X15 | 스레드 unread 대상 | `PRD.md:91` 미정 | `TRD.md:55` 사용자×스레드 행, `DESIGN_REFERENCE.md:286` "새 답글" | 대상 스레드 정의 없음 | PRD M-P1에서 정의 → TRD·디자인 따라감 |

## 5. 제 문서(개발설계서)에 R3에서 반영할 항목 — 자기 기록

평가 대상은 아니지만, 위 리뷰에서 드러난 제 문서의 결함을 미리 적습니다. R3 반영 기록 표에 넣겠습니다.

1. `DEV_DESIGN.md:83` 단일 커서 가정 → TRD의 M-T1 결론으로 교체(X1).
2. `DEV_DESIGN.md:204` FR-MSG-05 테스트 이름의 403 → 참여자 403 / 비참여자 404로 분리(X2).
3. `DEV_DESIGN.md:216` FR-CLIENT-02 → medium 2단 경계 케이스 추가(X4).
4. `DEV_DESIGN.md:201` 테스트 파일명 → `send-state`(X13). `DEV_DESIGN.md:270` 테이블명 → TRD 이름(X12).
5. 매핑 표에 M-T2 회귀 테스트("수정→삭제 후 이전 커서 sync 시 본문 0건")를 FR-MSG-05 보조 테스트로 추가.

## 사실 / 추정 / 확인 필요

- **사실:** 위 `file:line`은 리뷰 시점 파일 기준입니다. `~/Work/shared-infra/docker-compose.yml:7`은 `postgres:15-alpine`입니다.
- **추정:** 전역 커서의 경합 영향이 작다는 판단, M-T6의 제안 수치, URL 프래그먼트가 HTTP 요청에 실리지 않는다는 서술(일반 웹 지식, 이번 세션 재조회 안 함).
- **확인 필요:** back/forward cache가 SPA 메모리 상태를 복원하는 브라우저별 조건(PRD Should-fix 2), macOS Option+화살표 기본 동작의 브라우저별 차이(디자인 Should-fix 2).
