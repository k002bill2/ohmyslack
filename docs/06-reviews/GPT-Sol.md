# ohmyslack R2 상호 평가 — GPT-Sol

- 상태: R2 리뷰 완료 / 작성자: GPT-Sol / 날짜: 2026-11-07
- 대상: TRD·DEV_DESIGN·DESIGN_REFERENCE의 R1. PRD는 비교 기준으로만 읽었으며 자기 문서 채점은 하지 않았습니다.
- 입력: `docs/00-research/BUZZ_ROUND2_DOCS.md` 0–5절, 해당 4개 문서, `CLEANROOM.md`.
- 모든 `docs/...:행`은 저장소 루트 기준이며 아래 SHA-256의 R1 내용을 가리킵니다. 외부 링크·현재 라이브러리 동작·법률을 새로 조사하지 않았습니다.
- 이번 라운드는 이 파일만 작성했습니다. 코드·설치·Git·DB·.env·shared-infra·브라우저·제품 테스트 작업은 하지 않았습니다. 인증·접근 경계는 security-audit 가이드 모드로 문서만 검토했습니다.

## 1. 결론·점수

**세 문서 모두 R3의 기반으로 채택할 가치가 있습니다. 다만 동기화 계약·검증 게이트·사용자 상태 안내를 고친 뒤 최종 채택해야 합니다.** 확정된 개인 전용·방향 1·Tailscale·PostgreSQL 원장·웹/PWA·Redis 미사용 결정에는 이견이 없습니다.

점수는 1=재작성 필요, 3=핵심 수정 필요, 5=현재 단계에서 바로 구현 가능한 수준입니다. 단순 평균은 채택 결정이나 제품 검증 결과가 아닙니다.

| 문서 | 정확성 | 완결성 | 문서 간 정합성 | 구현 가능성 | 판정 |
|---|---:|---:|---:|---:|---|
| TRD / GPT-Luna | 3 | 3 | 3 | 3 | 메시지/읽음 복구 계약을 닫아야 합니다 |
| 개발설계서 / Claude-Opus 5.5 | 4 | 4 | 4 | 4 | FR 매핑은 정확하며 지정 테스트의 검증 범위를 보강해야 합니다 |
| 디자인 레퍼런스 / Claude-Fable | 4 | 4 | 4 | 4 | 상태·접근성이 구체적이며 모순된 안내와 레이아웃·IME 계약을 정리해야 합니다 |

Must-fix는 R3에서 반영하거나 근거 있는 거절을 기록할 항목입니다. 아래는 **문서 결함·계약 미정의**이며 실행 중 제품의 확인된 취약점이 아닙니다.

## 2. TRD 평가

### Must-fix

| 번호 | 근거 file:line | 문제·영향 | 제안 수정·완료 조건 |
|---|---|---|---|
| SOL-T1 | `docs/03-trd/TRD.md:50`, `:53`, `:75`, `:88`, `:96`; `docs/02-prd/PRD.md:90`, `:173` | sync_cursor는 대화별인데 `/api/sync?since={cursor}`에는 대화 식별자나 커서 묶음이 없습니다. 서로 다른 두 대화가 같은 숫자를 가질 때 조회 범위·중복 제거 키가 모호합니다. catch-up→subscribe 사이의 재비교도 요청/응답·종료 조건이 없습니다. | 대화별 `(conversation_id,cursor)` 또는 전역/계정별 커서 중 하나로 고정합니다. 요청·페이지 응답·상한 watermark·has_more/next·중복 키·구독 ACK와 유실 경합 처리·410 snapshot/서버 복원 epoch 계약을 제시합니다. 두 대화의 동일 숫자 커서와 복구 도중 새 이벤트로 누락 0을 검증할 수 있어야 합니다. |
| SOL-T2 | `docs/03-trd/TRD.md:53`–`:55`, `:60`, `:76`, `:92`, `:96`; `docs/04-dev-design/DEV_DESIGN.md:83`; `docs/02-prd/PRD.md:91`–`:95` | 변경 로그는 create/edit/delete만 있고 `read.updated`에는 thread_root_id가 없습니다. 단절 중 다른 기기가 스레드를 읽었을 때 읽음 복구 경로도 없습니다. 단순 max(request)는 미래 seq·다른 대화/스레드 위치를 거절하는 계약이 아닙니다. | 읽음 응답·이벤트에 대화/스레드 식별자·서버 확정 위치를 넣습니다. 읽음 변경 로그 포함 또는 재개 시 읽음 snapshot 조회를 명시하고, 요청 위치의 범위·대화/스레드 소속·최대 유효 위치를 검증합니다. 스레드 2개+본문, 단절 기기 복귀, 오래된/미래 요청으로 수렴 테스트를 명세합니다. |
| SOL-T3 | `docs/03-trd/TRD.md:41`–`:56`, `:66`–`:78`; `docs/02-prd/PRD.md:56`, `:65`–`:68`, `:80`–`:81` | 필수 API 표에 멤버 비활성화·채널 생성/참여/나가기·DM 시작·스레드 답글 조회·참여자 선택 경로가 없습니다. DDL 수준을 약속했지만 FK/delete 동작·enum/check·공개 채널명 유일성·DM 쌍 제약·thread_root의 동일 대화/1단 제약이 정해지지 않았습니다. payload 상한·rate limit·세션 만료도 미정입니다. | P0 FR→API/권한/DTO 표와 실제 구현 가능한 제약 표를 추가합니다. 자기 참조 스레드·교차 대화 root·동시 DM 생성·퇴장 후 기존 구독 차단을 포함합니다. 수치·정책은 R3 가정/결정으로 구체화하고, 후속 WBS에 결정 책임·시점을 연결합니다. |
| SOL-T4 | `docs/03-trd/TRD.md:52`–`:60`, `:75`, `:89`–`:91`; `docs/02-prd/PRD.md:79` | change log에 과거 snapshot이 남는 구조에서 삭제 후 과거 create/edit를 그대로 replay하면 삭제된 본문이 복구 응답에 다시 섞일 수 있습니다. 본문 제거 선언만 있고 과거 snapshot의 redaction·현재 tombstone 투영 방법이 없습니다. | 삭제 시 이전 snapshot을 정리하거나 sync 응답을 현재 tombstone 상태로 투영하는 등 한 방식을 명세합니다. 삭제 전 커서부터 여러 페이지를 복구해도 삭제 본문·멘션이 한 번도 반환되지 않는 테스트를 추가합니다. 백업 보존 문제와 서비스 replay 문제를 구분합니다. |

### Should-fix

1. `docs/03-trd/TRD.md:142`의 `latency bucket`·`duration bucket`은 PRD `docs/02-prd/PRD.md:142`–`:146`의 `duration_ms`·`count` 필드와 다릅니다. 키·enum·보관 7일 가정을 하나의 계약으로 정리해 주세요.
2. `docs/03-trd/TRD.md:105`의 plain text 렌더와 PRD `:75`의 코드 블록·링크 표시를 함께 만족하는 제한 문법·멘션 ID 전달/수정 규칙을 추가해 주세요. `:89`–`:90` 이벤트에는 멘션·답글 수 데이터가 없으므로 UI가 재조회할지 필드를 받을지 정해야 합니다.
3. `docs/03-trd/TRD.md:156`은 robots/약관 미확인을 명시합니다. R3에서는 링크를 실제 검증 근거와 미조회 참고 목록으로 나눠 주세요. 이번 리뷰는 해당 공식 사이트를 조회하지 않았으므로 외부 내용의 사실 판정을 하지 않습니다.
4. `docs/03-trd/TRD.md:116`의 loopback 외 listener 금지는 `:24`/`:125`의 tailnet Serve listener까지 금지한다고 읽힐 수 있습니다. 앱 백엔드·DB 포트와 허용된 Serve HTTPS endpoint를 구분해 주세요.

### 동의하는 강점

1. `docs/03-trd/TRD.md:17`, `:58`은 DB 원장·커밋 후 ACK·멱등성을 일관되게 묶습니다. Redis 없이 개인용 시스템을 구현하기에 적절한 기반입니다.
2. `docs/03-trd/TRD.md:125`–`:127`은 tailnet 접근과 앱 인증을 구분하고, API/본문 캐시 금지·오프라인 발신 큐 제외를 PWA 계약에 반영했습니다.

## 3. 개발설계서 평가

### Must-fix

| 번호 | 근거 file:line | 문제·영향 | 제안 수정·완료 조건 |
|---|---|---|---|
| SOL-V1 | `docs/04-dev-design/DEV_DESIGN.md:112`, `:143`, `:151`, `:223`; `CLEANROOM.md:38`–`:39`; `docs/02-prd/PRD.md:116` | CLEANROOM 명령을 그대로 실행한다고 하면서 스캐너 오류는 실패라고 요구합니다. 원문 명령은 grep의 '일치 없음'과 실행 오류를 분리하지 않아 grep 오류가 `echo CLEANROOM OK`로 이어질 수 있습니다. 표의 스캐너 오류 실패 조건과 모순입니다. | 패턴·제외 목록은 정본에서 읽되 grep 종료 코드 0=위반 실패, 1=정상, 그 외=실행 오류 실패로 분기하도록 설계합니다. 깨진 경로/읽기 오류/명령 실패·위반 fixture·정상 fixture를 검사기 자체 테스트에 넣습니다. 본 리뷰에서는 CLEANROOM 원본을 수정하지 않았습니다. |
| SOL-V2 | `docs/04-dev-design/DEV_DESIGN.md:72`, `:199`; `docs/03-trd/TRD.md:74`–`:76`; `docs/02-prd/PRD.md:68` | 자동 수집 대상이 `:conversationId` 경로만이면 `/api/messages/:id`, 전역 `/api/sync`, body로 대화를 받는 `/api/read-state`가 빠질 수 있습니다. 함수 하나를 지정하는 것만으로 간접 리소스 접근이 검증되지 않습니다. | 경로 변수명이 아니라 리소스/대화 접근 정책을 가진 전체 endpoint·WS action 레지스트리를 기준으로 매트릭스를 만듭니다. message_id→conversation 해석·동기화 응답 필터·읽음 업데이트를 포함하고 비참여자/퇴장/비활성 계정으로 검증합니다. |
| SOL-V3 | `docs/04-dev-design/DEV_DESIGN.md:183`, `:201`, `:208`, `:211`; `docs/02-prd/PRD.md:76`, `:89`, `:92` | 지정 테스트가 FR의 판정 기준인데 MSG-02는 UI 테스트만 있어 재시작 후 영속성 조건이 빠져 있습니다. SYNC-01은 Node 부하 도구만 있고 실제 '기기 표시' 시점을 관측하는 경로가 없습니다. SYNC-04 역시 프로토콜 수신과 UI 배지 일치를 구분해야 합니다. | FR 1개→주 지정 테스트 1개 매핑은 유지하되 필수 보조 증거를 열로 추가합니다. MSG-02에 실제 commit/롤백·서버 재시작 테스트, SYNC-01에 UI 적용 시점 계측 또는 프로토콜 지연과 UI 지연 별도 게이트, SYNC-04에 배지 반영 컴포넌트/실기기 검증을 연결합니다. 수신만으로 표시 통과를 주장하지 않도록 명시합니다. |
| SOL-V4 | `docs/04-dev-design/DEV_DESIGN.md:92`, `:111`–`:112`, `:144`, `:150` | 빈 골격에서 전체 verify 통과를 요구하지만 coverage checker는 33개 테스트/체크리스트가 있어야 통과합니다. 또 '이름 또는 수동 파일 중 하나 존재' 방식은 지정 테스트 중복·skip/todo·빈 체크리스트를 막지 못합니다. | G0의 도구 smoke gate와 G1의 완전 FR gate를 분리하고 개발 중 적용 상태를 명시합니다. FR별 주 지정 테스트 유일성·발견된 실행 결과·필수 수동 증거를 대조하며, skip/todo/빈 항목은 G1에서 실패시키도록 명세합니다. 부분 구현의 범위와 전체 패키지 회귀 실행은 구분합니다. |

### Should-fix

1. `docs/04-dev-design/DEV_DESIGN.md:149`, `:232`, `:258`의 테스트 DB 접미사 검사는 오접속 방어의 일부입니다. 전용 role의 권한·허용 host/DB와 실행별 schema 격리·정리 범위를 함께 명시해 주세요. 공용 PostgreSQL 변경 외에 별도 로컬 테스트 인스턴스의 선택 가능성도 비교하면 좋겠습니다.
2. `docs/04-dev-design/DEV_DESIGN.md:180`, `:250`은 브라우저 확인용 도구 제한을 저장소 설치 전면 금지로 확대 서술합니다. 현재 사용자 지시대로 ego-browser·실기기 QA를 쓰되, 직접 지시와 설계상의 보수적 선택을 구분해 주세요. 이번 라운드에 새 도구 도입을 요구하는 의견은 아닙니다.
3. `docs/04-dev-design/DEV_DESIGN.md:273`/`:216`에 디자인 3구간과 1024px 경계·중간 폭, TRD TR-SEC→테스트 보조 표를 R3에서 붙여 주세요. 이 문서가 먼저 작성되었다는 이유로 R1의 가정을 결함으로 단정하지는 않습니다.

### 동의하는 강점

1. PRD P0와 지정 테스트 ID를 정적 비교한 결과 **33=33, 누락 0, 추가 0**입니다(`docs/04-dev-design/DEV_DESIGN.md:191`–`:225`). 이는 문서 추적성 확인이며 테스트 통과 결과는 아닙니다.
2. `docs/04-dev-design/DEV_DESIGN.md:174`–`:181`, `:187`은 프로토콜·컴포넌트 테스트의 한계를 인정하고 실기기 수동 증거를 함께 요구합니다. 역할·WBS·게이트도 구현자와 검증자를 분리합니다.

## 4. 디자인 레퍼런스 평가

### Must-fix

| 번호 | 근거 file:line | 문제·영향 | 제안 수정·완료 조건 |
|---|---|---|---|
| SOL-D1 | `docs/05-design-ref/DESIGN_REFERENCE.md:300`–`:314`; `docs/02-prd/PRD.md:76`–`:77`; `docs/03-trd/TRD.md:58` | 연결 끊김 문구 '보낸 메시지는 저장되지 않았습니다'는 ACK만 유실되고 DB에는 저장된 경우와 모순입니다. 사용자에게 재작성/중복 전송을 유도할 수 있습니다. | 연결 배너는 '연결이 끊겼습니다. 저장 여부를 확인 중입니다'처럼 상태 불확실성을 표시하고, 메시지별 저장 확인/미확인/명시 실패를 분리합니다. 동일 client_message_id 재시도로 저장 여부를 확인하는 상태 전이를 명세합니다. 이미 확인된 메시지는 연결 단절만으로 실패로 바꾸지 않습니다. |
| SOL-D2 | `docs/05-design-ref/DESIGN_REFERENCE.md:213`–`:240`, `:457`; `docs/02-prd/PRD.md:102` | wide 시작 1024px에서 지정 폭 합계는 260+480+380=1120px입니다. 1280 미만 접힘은 선택이라 1024px+스레드에서 가로 넘침 0을 보장하지 못합니다. 640/641·1023/1024 사이 소수 CSS px의 media query 공백도 있습니다. | 1120px 미만에서 접힘을 필수화하거나 유연 폭/오버레이 규칙을 확정합니다. 구간은 compact≤640, medium>640 및 <1024, wide≥1024처럼 연속으로 정의합니다. 640.5·1023.5·1024px, 스레드 열림·확대 상태를 QA/테스트에 추가합니다. |
| SOL-D3 | `docs/05-design-ref/DESIGN_REFERENCE.md:363`–`:368`; `docs/02-prd/PRD.md:82`; `docs/04-dev-design/DEV_DESIGN.md:207` | compositionend 후 Enter 1회 무시가 조합 확정과 독립된 다음 Enter까지 삼키는지 불명확합니다. Shift+Enter는 조합 여부와 무관하게 줄바꿈하라고 하여 '조합 중 아무것도 하지 않음'과도 충돌합니다. | 입력 처리 우선순위를 조합 보호→멘션 선택→줄바꿈/전송으로 정합니다. 조합 확정에 속한 키와 이후 독립 Enter를 구분하는 상태·해제 조건을 정하고, 무관한 Enter를 무조건 버리지 않습니다. 조합 중 Shift+Enter·마우스 확정 후 Enter·연속 입력·ACK 중 새 조합을 실기/이벤트 순서 매트릭스에 넣습니다. |
| SOL-D4 | `docs/05-design-ref/DESIGN_REFERENCE.md:273`–`:294`, `:439`–`:451`; `docs/02-prd/PRD.md:54`, `:56`, `:66`–`:67` | P0 기능인 DM 시작 대상 선택·채널 참여/나가기·멤버 비활성화의 진입점/상태가 화면·컴포넌트 표에서 구체화되지 않았습니다. 개인 1명 사용이어도 합성 계정 시나리오 S1·S3 검증과 초대/DM 기능은 확정 범위입니다. | 새 컴포넌트를 반드시 늘릴 필요는 없습니다. Sidebar/Dialog 등 기존 컴포넌트에 해당 행동·관리자 노출·퇴장 후 접근 차단/목록 유지·비활성화 확인·오류/빈 상태를 매핑합니다. S1/S3/FR-CONV-02를 UI에서 처음부터 끝까지 따라갈 수 있게 화면 흐름을 추가합니다. |

### Should-fix

1. `docs/05-design-ref/DESIGN_REFERENCE.md:66`의 폰트 수정·RFN·서브셋 파일명 규칙은 구현자가 그대로 집행할 수 있는 단정입니다. OFL 원문 조항과 허용/조건/금지의 구분을 재검토하고 필요한 고지 파일·배포 버전/커밋을 함께 적어 주세요. 이번 리뷰는 라이선스 원문을 새로 확인하지 않았으므로 법적 위반을 판정하지 않습니다.
2. `docs/05-design-ref/DESIGN_REFERENCE.md:53`, `:56`, `:464`는 이미지 경로를 전면 제한하면서 디자인 산출물 저장과 충돌할 수 있습니다. 배포 에셋·라이선스 에셋·문서/QA 증거를 나눠 출처 목록으로 관리하는 쪽을 권합니다. 클린룸 검증이 경로만으로 출처 검토를 대체하지 않아야 합니다.
3. `docs/05-design-ref/DESIGN_REFERENCE.md:188`의 thread와 `:240` 오버레이 닫기, `:351`–`:352` 입력 중 Esc 무동작을 조율해 주세요. 딥링크로 직접 연 경우 뒤로 버튼의 fallback·입력 보존, 모달 Esc 탈출이 우선하는 경우가 필요합니다.
4. `docs/05-design-ref/DESIGN_REFERENCE.md:283`은 전송 중 입력 유지와 재전송 금지를, `:367`은 전송 후 비우기를 명시합니다. ACK가 늦는 동안 새로 쓴 초안이 지워지지 않는 조건을 추가해 주세요. 다크 모드는 `:374`의 필수처럼 보이는 문구와 `:515`의 결정 대기를 통일해 주세요.

### 동의하는 강점

1. `docs/05-design-ref/DESIGN_REFERENCE.md:273`–`:315`의 컴포넌트·상태·문구 매트릭스는 Designer handoff와 QA의 공통 기준으로 쓸 수 있습니다. 서버 확정 전 성공 표시 금지와 로컬 재시도 ID 유지가 명확합니다.
2. `docs/05-design-ref/DESIGN_REFERENCE.md:320`–`:369`, `:455`–`:464`는 접근성·IME·모바일 검증을 FR 및 QA 증거와 연결합니다. 클린룸 토큰의 출처·미확인 사항을 따로 드러낸 점도 좋습니다.

## 5. 문서 간 충돌·미정합 목록

직접 모순과 한쪽 계약이 빠진 경우를 구분했습니다. 이름이 같다는 이유만으로 payload 정합을 확인했다고 주장하지 않습니다.

### 5-1. 데이터·이벤트·API

| ID | 종류 | 양쪽 근거 file:line | R3 정합안 |
|---|---|---|---|
| X1 | 커서 범위 미정의 | `docs/03-trd/TRD.md:50`·`:53`·`:75` ↔ `docs/04-dev-design/DEV_DESIGN.md:83`·`:271` | URL 이름은 같지만 대화별 cursor와 변경 복구 단위가 미정입니다. SOL-T1로 범위를 고정합니다. |
| X2 | 읽음 내구성·payload 누락 | `docs/03-trd/TRD.md:53`·`:92` ↔ `docs/04-dev-design/DEV_DESIGN.md:83`–`:84`, `docs/02-prd/PRD.md:91`·`:95` | DEV는 변경 커서에 읽음을 포함, TRD 변경 로그는 메시지 op만 정의합니다. 스레드 ID·복귀 snapshot/로그 경로를 통일합니다. |
| X3 | 계측 키 이름 불일치 | `docs/03-trd/TRD.md:142` ↔ `docs/02-prd/PRD.md:142`–`:146`, `docs/04-dev-design/DEV_DESIGN.md:274` | duration_ms/count 등 PRD 허용 키와 실제 DTO를 맞춥니다. |
| X4 | UI 데이터 계약 누락 | `docs/05-design-ref/DESIGN_REFERENCE.md:284`·`:286`·`:305`·`:506` ↔ `docs/03-trd/TRD.md:56`·`:89`–`:92` | DB message_mentions와 UI를 직접 연결하지 말고 멘션 ID 배열/답글 수/읽음 결과의 응답 또는 재조회 계약을 정합니다. |
| X5 | 최소 메시지 응답 차이 | `docs/04-dev-design/DEV_DESIGN.md:82` ↔ `docs/03-trd/TRD.md:73` | DEV 응답은 message_id/seq, TRD는 sync_cursor도 포함합니다. TRD 확정 DTO를 shared 정본과 DEV 흐름에 맞춥니다. |

### 5-2. 수용 기준·화면·검증

| ID | 종류 | 양쪽 근거 file:line | R3 정합안 |
|---|---|---|---|
| X6 | 저장 상태 직접 모순 | `docs/05-design-ref/DESIGN_REFERENCE.md:313` ↔ `docs/02-prd/PRD.md:76`–`:77`, `docs/03-trd/TRD.md:58` | ACK 유실을 미저장으로 단정하지 않도록 SOL-D1 반영 |
| X7 | IME 수용 기준 모호성 | `docs/05-design-ref/DESIGN_REFERENCE.md:365`–`:366` ↔ `docs/02-prd/PRD.md:82`, `docs/04-dev-design/DEV_DESIGN.md:207` | 조합 확정 이벤트와 이후 전송 Enter를 분리하며 조합 중 입력을 보호합니다. |
| X8 | 레이아웃 범위 추가·폭 충돌 | `docs/05-design-ref/DESIGN_REFERENCE.md:213`–`:235` ↔ `docs/02-prd/PRD.md:101`–`:102`, `docs/04-dev-design/DEV_DESIGN.md:216`·`:273` | 640은 일치하며 디자인이 1024/2단을 추가 제안했습니다. 1024에서 1120 고정 폭 충돌을 먼저 해소하고 FR·QA 범위에 반영합니다. |
| X9 | 컴포넌트·테스트 파일명 드리프트 | `docs/05-design-ref/DESIGN_REFERENCE.md:500`의 conversation/send-state ↔ `docs/04-dev-design/DEV_DESIGN.md:201`의 conversation/send-status.test.tsx | 실제 파일은 아직 가정입니다. 상태 컴포넌트 CMP-07/11과 하나의 테스트명으로 정합합니다. |
| X10 | 검사 실패 처리 직접 모순 | `docs/04-dev-design/DEV_DESIGN.md:143`·`:151`·`:223` ↔ `docs/02-prd/PRD.md:116`, `CLEANROOM.md:38`–`:39` | 원문 그대로 호출과 실행 오류 실패를 동시에 만족하도록 종료 코드 처리 규칙을 보완합니다(SOL-V1). |

FR ID는 P0 33개가 일치합니다. 테이블명은 개발설계서가 상당 부분 일반 명칭의 가정으로 남겨 두어, 실제로 상충하는 영문 테이블명이 있다고 단정하지 않습니다(`docs/04-dev-design/DEV_DESIGN.md:270` ↔ `docs/03-trd/TRD.md:45`–`:56`). `conversation_id`와 UI `conversationId`는 JSON 필드/라우트 변수 표기 차이로서 변환 경계만 명시하면 됩니다.

## 6. 사실 / 추정 / 확인 필요·검증 기록

1. **사실:** 위 R1 문서 전문을 읽고 행 번호로 대조했습니다. PRD P0 33개와 개발설계서 FR 매핑 33개를 정적으로 비교해 누락/추가 0을 확인했습니다. 제품 코드·테스트 결과는 확인하지 않았습니다.
2. **추정:** 모호한 커서·snapshot·UI 계약을 그대로 구현하면 위 실패가 발생할 수 있다는 설계 판단입니다. 실제 구현 버그나 취약점 재현 결과가 아닙니다. 점수는 이 구현 준비도 기준의 상대 평가입니다.
3. **확인 필요:** R3에서 Must-fix별 반영/근거 있는 거절, 실제 API/이벤트·DDL 정본, 수치 목표와 지원 기기 검증 방법을 확정해야 합니다. 외부 라이선스·프레임워크 최신 동작·실기기 결과는 재검증하지 않았습니다.
4. **범위:** R2 결과물은 이 리뷰 파일 하나입니다. PRD·TRD·개발설계서·디자인 레퍼런스는 수정하지 않았습니다. R3 시작 신호 전에는 이 리뷰를 원문에 적용하지 않습니다.

### 검토한 R1 파일 SHA-256

- `docs/02-prd/PRD.md`: `20a60f8877e17cc5e29be2d095e9e4b07e330176e891365c05d925323216faaa`
- `docs/03-trd/TRD.md`: `2380b478753e8ccdeb8490306f92774b299c272caa73578aef92cd0aefaedc32`
- `docs/04-dev-design/DEV_DESIGN.md`: `38da7fbec8035f6f6a35d307fd0777eba1abaccb33bd5c4176086197bb7bbdcc`
- `docs/05-design-ref/DESIGN_REFERENCE.md`: `59e5804250d32b481ffe7e6462b04c40784991896de9c5db4be41e84e9eaf93e`
