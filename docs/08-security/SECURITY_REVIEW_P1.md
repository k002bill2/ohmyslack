# SECURITY_REVIEW_P1 — W-15 P1 MVP 보안 리뷰

> 기준 커밋: `main 3e83e47`(worktree `p1-w15-security`). 작성일 2026-11-07. 읽기 전용 리뷰라 코드는 바꾸지 않았습니다.
> 대조한 정본: TRD R3.2 §3·§4·§5·§5-1(S1–S13)·§6, `docs/08-security/THREAT_MODEL.md`, DEV_DESIGN §2-4·§6-3.
> 방법: 소스 정적 분석이 기본입니다. 메모리 `app.inject`와 함수 단위 재현, 테스트 DB(`.env.test`) 통합 테스트를 함께 썼습니다. 운영 DB·운영 `.env`·외부 네트워크에는 접근하지 않았습니다.
> 심각도 기준(security-audit):
> - High: 명시된 통제를 완전히 우회하고 실제 피해(계정 탈취, 참여자 밖 본문 노출, 다른 사용자에게 저장형 스크립트 실행)가 생기는 경우
> - Medium: 경계 위반이지만 영향 범위가 제한적인 경우
> - Low: 영향이 작거나 전제 조건이 드문 경우

## 최종 판정

**`W-15 PASS`** — Critical 0, High 0, Medium 1, Low 5.

## 1. 결함 목록 (심각도순)

### F-1 · Medium · 메시지 본문 파서의 O(n²) 처리로 생기는 저장형 클라이언트 DoS

**위치**
- `apps/web/src/features/conversation/render.ts:21-23`: `count()`가 호출될 때마다 문자열 전체를 `split`합니다.
- `render.ts:26-36`: `trimTrailing`이 한 글자를 뗄 때마다 `count`를 다시 부릅니다.
- `render.ts:17`: `LINK_CANDIDATE`가 콜론 없는 긴 단어에서 시작 위치마다 끝까지 다시 스캔합니다.
- `MessageBody.tsx`, `MessageItem.tsx`에 `useMemo`·`React.memo`가 없어, store가 이벤트를 낼 때마다 보이는 모든 메시지가 다시 파싱됩니다.

**재현(메인에서 직접 측정)**
- 측정 스크립트: `dev/active/p1-w15-security/perf.ts`(`npx tsx`로 실행, 5회 평균)
- `'http://a.co/' + ')'.repeat(3988)`(4000자): **93.9 ms/parse**
- `'a'.repeat(4000)`: 27.0 ms/parse
- 일반 링크 본문(3990자): 0.2 ms/parse
- 4000자는 서버 상한 `MESSAGE_BODY_MAX`(`packages/shared/src/messages.ts:4`) 안이라 서버 검증을 통과합니다.
- 대화 멤버가 이런 메시지를 N개 보내면, 그 대화를 연 모든 사용자의 메인 스레드가 이벤트 1회마다 약 N×(30–150) ms 멈춥니다. 이벤트는 `message.created`, `read.updated`, 연결 상태 변화 등입니다. 서브에이전트 측정으로는 N=100일 때 이벤트마다 약 10초 이상입니다.

**영향:** 기밀성·무결성 영향은 없습니다. 인증된 멤버가 다른 멤버 화면의 가용성을 떨어뜨립니다.

**수정 지시**
1. `trimTrailing`에서 열고 닫는 괄호 수를 한 번만 세고, 한 글자를 뗄 때마다 증감합니다(O(n)).
2. `LINK_CANDIDATE`에 시작 경계를 둡니다. 예: `(?<![A-Za-z0-9+.-])`. 또는 후보를 `https?://`로 좁힙니다.
3. `MessageBody`에 `useMemo(() => parseBody(body), [body])`를 쓰고 `MessageItem`을 `React.memo`로 감쌉니다.

**회귀 테스트:** `apps/web/test/conversation/render-perf.test.ts`
- 위 두 입력 각각 `parseBody`가 20 ms 이하인지 단언합니다.
- 기존 `Function_(mathematics)` 괄호 보존 테스트가 계속 통과해야 합니다.

### F-2 · Low · `reset-password` CLI가 열린 WS를 닫지 못함 (S4·NC-21 미충족)

**위치**
- `apps/server/bin/reset-password.ts:16`: 훅 없이 `runResetPassword`를 부릅니다.
- `apps/server/bin/lib/reset-password.ts:33-39`: DB `revoked_at` 갱신만 하고, 훅은 선택 사항입니다.
- 실행 중인 서버의 hub는 같은 프로세스 안의 `sessionRevoked` 이벤트에만 반응합니다(`apps/server/src/modules/realtime/hub.ts:198-201`). 서버에 LISTEN/NOTIFY가 없습니다.

**재현**
1. 사용자 A의 WS가 유휴 상태로 열려 있습니다.
2. 운영자가 `reset-password --email A`를 실행합니다.
3. WS는 5초 뒤에도 열려 있습니다. 다음 팬아웃이나 만료 타이머(`hub.ts:146`, 최대 약 24.8일)가 올 때까지 유지됩니다.

**Low인 이유**
- 전송 경로마다 `sessionAlive`로 다시 확인합니다(`hub.ts:116,136,177,248,254`). 그래서 새 이벤트·본문은 전달되지 않습니다.
- HTTP 요청은 즉시 401입니다.

기존 `test/auth/reset-password.int.test.ts:10`은 훅 호출까지만 단언하므로 이 결함을 잡지 못합니다. 런북 `docs/runbooks/BOOTSTRAP_OWNER.md:51`의 "W-09 전에는 복구 후 서버를 재시작"은 W-09가 병합된 지금 오해를 부릅니다.

**수정 지시:** 둘 중 하나를 고르고, 어느 쪽이든 런북 51행을 고칩니다.
- (a) 권장: `hub.ts`에 5초 이하 주기의 `unref` 타이머 sweep을 둡니다. 모든 연결에 `sessionAlive`를 실행합니다. 수동 SQL이나 복원처럼 프로세스 밖에서 일어난 폐기도 함께 처리됩니다.
- (b) reset 트랜잭션에서 `pg_notify('oms_session_revoked', …)`를 보내고, `main.ts`에서 전용 client로 LISTEN 해 `sessionRevoked`로 연결합니다.

**회귀 테스트:** `apps/server/test/ops/credential-reset.int.test.ts`(NC-21 지정 이름)를 만듭니다. WS를 연결한 채 훅 없이 `runResetPassword`를 실행하고, 5초 안에 close 1008이 오는지 단언합니다.

### F-3 · Low · 초대 수락으로 이메일 존재 여부를 반복 조회할 수 있음 (NC-20)

**위치**
- `apps/server/src/modules/members/repo.ts:96-101`: 이메일이 충돌하면 `rejected`(`commit:false`)를 돌려줍니다. 이 ROLLBACK이 `used_at` 갱신까지 되돌려 token이 살아남습니다.
- `apps/server/src/modules/members/routes.ts:60-61`

**재현**
1. 유효한 초대 token을 가진 사람이 `POST /api/invites/accept`로 기존 이메일을 보냅니다.
2. 응답은 400 `invite_invalid`이고 token은 그대로 남습니다.
3. 새 이메일로 같은 요청을 보내면 201입니다.
4. 이 차이로 이메일 존재 여부를 제한 없이 확인할 수 있습니다. `/api/members`는 이메일을 노출하지 않는데, 이 경로로는 알아낼 수 있습니다.

**Low인 이유:** 유효 token(72시간, owner 발급)이 전제입니다.

**수정 지시:** 충돌 분기에서도 invite 소모를 COMMIT 하고(`{commit:true, value:{ok:false}}`) 같은 오류를 돌려줍니다. 그러면 token 하나당 1회만 조회할 수 있습니다.

**회귀 테스트:** `invite-accept-input.int.test.ts`
- 기존 이메일 → 400
- 그 뒤 같은 token에 새 이메일 → 400

### F-4 · Low · 퍼센트 인코딩 경로로 S5 `Cache-Control: no-store`를 우회함

**위치:** `apps/server/src/http/security.ts:75-76`. 원문 `request.url` 접두사로 판정하지만, 라우터는 `/%61pi/...`를 `/api/...`로 디코드해 매칭합니다.

**재현(메인에서 직접 실행, `dev/active/p1-w15-security/nostore.ts`, 메모리 `app.inject`)**
- `GET /api/healthz` → 200, `cache-control: no-store`
- `GET /%61pi/healthz` → 200, `cache-control` **없음**

멤버가 본문에 `https://<host>/%61pi/sync` 같은 링크를 걸고 피해자가 클릭하면 Lax 쿠키가 실린 GET이 나갑니다. 그러면 본문이 든 인증 JSON이 브라우저 디스크 캐시에 남을 수 있습니다. SW에는 저장되지 않습니다. 런타임 `put`이 없기 때문입니다(`apps/web/src/features/pwa/sw-routing.ts:19-22`).

**수정 지시:** 판정 기준을 `request.routeOptions.url`(매칭된 패턴)로 바꿉니다. `app.ts:100`이 이미 이 값을 씁니다. 미매칭 요청에는 `decodeURI` 정규화를 적용합니다.

**회귀 테스트:** `auth-flow.unit.test.ts`에서 `GET /%61pi/healthz`의 응답이 `no-store`인지 단언합니다.

### F-5 · Low · 잘못된 URL 인코딩 응답이 S6 헤더·Host 가드·오류 형식을 모두 우회함

**위치:** `apps/server/src/app.ts:125`. `Fastify({...})`에 `frameworkErrors` 핸들러가 없습니다.

**재현(메인에서 직접 실행)**
- `GET /%zz` → 400
- CSP·nosniff·Referrer-Policy 헤더가 **없습니다**.
- 본문이 `{"error":"Bad Request","code":"FST_ERR_BAD_URL","message":"'/%zz' is not a valid url component",...}`로, 요청 경로를 반사합니다.
- 허용되지 않은 Host(`evil.test`)에서도 같은 응답이 나갑니다(메인 재현). 같은 Host로 `/api/healthz`를 요청하면 `host_not_allowed`이므로, NC-04 가드보다 앞에서 처리된다는 것이 확인됩니다.

**Low인 이유:** JSON content-type이고 퍼센트 인코딩 상태라 실행 가능한 XSS는 아닙니다. 다만 S6 "모든 응답"과 TRD §3 오류 형식(`{error:{code,request_id}}`)을 위반합니다.

**수정 지시:** `frameworkErrors: (err, req, reply) => …`에서 S6 헤더를 직접 설정하고 `{error:{code:'invalid_request',request_id}}`로 응답합니다.

**회귀 테스트:** `GET /%zz`에 대해 다음을 단언합니다.
- 400
- `error.code === 'invalid_request'`
- CSP·`nosniff`·`no-referrer` 헤더 존재
- 본문에 원문 URL 미포함

### F-6 · Low · S12(복원 뒤 세션·미사용 초대 무효화) 미구현

**위치:** `tools/restore-drill*`와 `docs/runbooks/RESTORE_DRILL.md` 어디에도 S12 단계가 없습니다(grep 0건).

**Low인 이유:** 지금 도달할 수 없습니다. 드릴은 합성 데이터만 쓰고 서비스를 재개하지 않으며, 운영 복원은 별도 승인 사항입니다(`RESTORE_DRILL.md:73`).

**수정 지시:** 운영 복원 절차를 승인하기 전에 다음을 넣습니다.
1. `RESTORE_DRILL.md`에 "서비스 재개 전" 단계를 추가합니다.
   - `UPDATE sessions SET revoked_at=now() WHERE revoked_at IS NULL`
   - `UPDATE invites SET revoked_at=now() WHERE used_at IS NULL AND revoked_at IS NULL`
2. 드릴 대조 항목에도 이 단계를 넣습니다.
3. 비활성화 목록을 다시 적용하는 방식은 PRD ⚖️-3이 결정되면 정합니다.

### 강화 권고 (도달 가능한 위반 없음, 심각도 없음)

**H-1. 라우트 레지스트리가 `account` 라우트의 가드를 강제하지 않음**
- `apps/server/src/http/access.ts:64-72`는 `admin`·`conversation`·`message`만 표시된 가드를 요구합니다. `{access:'account'}`는 `preHandler` 없이도 등록됩니다. 이렇게 등록되면 인증 없이 실행되고, CSRF 검사(`auth/guards.ts:30-33`)도 건너뜁니다.
- 현재는 모든 account 라우트에 `accountGuard`가 붙어 있습니다.
- `sync/routes.ts:96-104`의 snapshot과 `PUT /api/read-state`는 DEV_DESIGN §2-4에서 `conversation` 등급인데 `account`로 선언돼 있습니다.
- 권고:
  1. `markAccountGuard`를 만들어 account 등급에 강제합니다.
  2. 위 두 라우트를 `conversation` 등급으로 바꿉니다.
  3. 가드 없는 account 라우트가 있으면 기동 시 실패하는지 테스트합니다.

**H-2. owner 자기 비활성화 판정이 대소문자를 구분함**
- `members/routes.ts:71`의 `targetId === actor.id`는 대문자 UUID를 놓칩니다.
- 도달할 수는 없습니다. 마지막 owner 검사(`members/repo.ts:48-55`)가 409를 반환하고, 두 번째 owner를 만드는 경로가 없습니다.
- 권고: 비교 전에 소문자로 정규화하거나 SQL에서 uuid로 비교합니다.

**H-3. 관찰 사항**
- `apps/server/src/main.ts:19`의 `pg.Pool`에 `error` 리스너가 없습니다. PG가 재시작되면 프로세스가 크래시하고 raw stack을 출력합니다(TM-LOG-02와 관련).
- WS 프레임 속도와 연결 수에 제한이 없습니다. 정본에도 이 통제가 없습니다.
- `apps/server/src/app.ts:125`의 `logger:false`가 @fastify/websocket 내부 로그(url 포함)를 막는 유일한 통제입니다. logger를 켜면 다시 검토해야 합니다.

## 2. 점검 1–8 결론

| # | 항목 | 결론 | 근거 |
|---|---|---|---|
| 1 | 인증·세션 | 문제 없음 (F-2 Low 제외) | 아래 1번 |
| 2 | CSRF·Origin·Host | 문제 없음 (F-5 Low: 프레임워크 오류 응답이 Host 가드보다 앞섬) | 아래 2번 |
| 3 | 인가·IDOR | 문제 없음 (F-3 Low, H-1·H-2 권고) | 아래 3번 |
| 4 | XSS·렌더 | XSS 문제 없음. F-1 Medium(DoS), F-4·F-5 Low(S5·S6 헤더) | 아래 4번 |
| 5 | 클라이언트 저장 | 문제 없음 | 아래 5번 |
| 6 | 로그·계측 누출 | 문제 없음 (H-3 관찰) | 아래 6번 |
| 7 | 운영 경계 | 문제 없음 (F-2·F-6 Low) | 아래 7번 |
| 8 | 의존성 | 문제 없음 (dev moderate 1건) | 아래 8번 |

**1. 인증·세션**
- argon2id 파라미터가 S9와 같습니다: m=19456, t=2, p=1, tag 32, salt 16, `timingSafeEqual`(`auth/password.ts:7-13,100`).
- S1 로그인 제한
  - 키는 `normalizeEmail`(trim·NFC·소문자)과 전역입니다.
  - IP·프록시 헤더는 쓰지 않고 `trustProxy`가 꺼져 있습니다.
  - 직렬 큐로 동시 요청 우회를 막습니다(`service.ts:89-108`). 이는 w06a P1 수정 `c2f5f80`이 유지된 것입니다.
  - 전역 20회에 걸리면 owner도 잠기는 것은 S1의 설계상 수용입니다.
- 계정 열거: 없는 계정에도 더미 해시를 돌리고 같은 401을 돌려줍니다(`service.ts:79-83`).
- 세션 고정: 로그인·초대 수락 때 새 32바이트 token을 발급하고, 제시된 이전 세션을 폐기합니다(`service.ts:123-138`).
- 세션 수명
  - sliding 30일, 절대 90일입니다(`service.ts:8-9,28-30,145`).
  - 폐기된 세션은 `touchSession`으로 되살릴 수 없습니다(`auth/repo.ts:74`).
  - WS는 연장하지 않는 `peek`을 씁니다(S7).
- S4: 해시 교체와 전 세션 폐기를 한 트랜잭션에서 합니다(`bin/lib/reset-password.ts:28-38`). WS close는 F-2입니다.
- 쿠키
  - `__Host-oms_session`, HttpOnly, Secure(상수), SameSite=Lax, Path=/, Domain 없음입니다(`auth/routes.ts:10-16`, `guards.ts:8`).
  - 알 수 없는 앱 옵션이 들어오면 기동 시 거부합니다(`app.ts:84-90`).
  - 세션 token은 DB에 SHA-256 해시만 저장합니다.

**2. CSRF·Origin·Host**
- 상태 변경 라우트 14개를 메인이 `app.(post|put|patch|delete)` grep으로 직접 전수 확인했습니다.
  - public 2개(`POST /api/auth/login`, `POST /api/invites/accept`)는 Origin만 검사합니다.
  - account 3개: logout, `POST /api/dms`, `PUT /api/read-state`(+ `conversationRefGuard`)
  - admin 4개: `POST /api/conversations`, `/api/invites`, `/api/invites/:id/revoke`, `/api/admin/members/:user_id/deactivate`
  - conversation·message 5개: join, `DELETE .../membership`, 메시지 POST·PATCH·DELETE
  - 12개 모두 `accountGuard`(세션 + `X-CSRF-Token` `timingSafeEqual`)를 거칩니다.
- Origin
  - 문자열 정확 일치에 `URL.origin` 재확인까지 합니다. Origin이 없거나 `null`이면 거부합니다(`security.ts:29-36`).
  - 비GET 요청 전체에 root `onRequest`에서 검사합니다.
- Host: 허용 목록으로 검사합니다(`security.ts:19-26,54-55`).
- WS handshake: Origin을 정확히 비교하고 쿠키 `peek`을 합니다. URL token은 받지 않습니다(`realtime/gateway.ts:69-73`).
- GET 부작용은 sliding touch 외에 없습니다. CORS 플러그인도 없습니다.

**3. 인가·IDOR**
- `conversation`·`message`·`admin` 등급은 레지스트리가 표시된 가드를 강제합니다(`access.ts:64-72`). `account` 등급의 공백은 H-1입니다.
- 메시지 수정·삭제는 `lockOwn`이 멤버십을 확인한 뒤 `author_id`를 확인합니다(`messages/repo.ts:226-236`).
- admin은 요청마다 DB에서 역할을 다시 읽어 owner 여부를 판정합니다(`guards.ts:42-47`).
- 나간 대화: 접근 SQL이 `left_at IS NULL`을 요구합니다(`conversations/repo.ts:36-39`).
- 비활성 사용자: `peek`이 `status='active'`를 요구하고, 비활성화할 때 세션을 일괄 폐기합니다.
- 모든 요청 스키마가 `.strict()`입니다. actor는 항상 `requireAuth`에서 가져옵니다.
- promote·demote 라우트가 없고, 마지막 owner는 `FOR UPDATE`로 보호합니다.
- WS 클라이언트 프레임은 subscribe·unsubscribe 두 가지뿐입니다(`packages/shared/src/realtime.ts:17-20`). 쓰기는 모두 HTTP로만 합니다.
- 구독·replay·팬아웃마다 세션과 멤버십을 다시 확인합니다(`hub.ts:125-140,162-187,211-230`).

**4. XSS·렌더**
- `dangerouslySetInnerHTML`·`innerHTML`·`outerHTML`·`insertAdjacentHTML`·`document.write`·`new Function`·`eval` 0건입니다. 메인이 `apps/web/src`·`packages/shared/src`를 직접 grep했습니다. 데이터로 만든 `href`/`src`는 `MessageBody.tsx:10` 하나이고, 그 값은 `safeLinkHref`(`render.ts:56`)에서만 나옵니다.
- 본문 렌더 경로는 하나입니다: `MessageItem` → `MessageBody` → `parseBody`, React 텍스트 노드로만 렌더합니다.
- `safeLinkHref`는 `http:`·`https:`이고 host가 있을 때만 링크로 만듭니다(`render.ts:37-49`).
- `rel="noopener noreferrer"`가 있습니다(`MessageBody.tsx:10`).
- 이름류는 JSX 텍스트로만 렌더합니다.
- S6 CSP·nosniff·Referrer-Policy 값이 정본과 같습니다(`security.ts:5-10`). 200·400·404 응답 모두에 붙는 것을 메모리 inject로 확인했습니다. 예외는 F-5입니다.

**5. 클라이언트 저장**
- `localStorage`
  - checkpoint 한 곳(`features/sync/checkpoint.ts`)에서만 씁니다.
  - 키는 `oms.cp.<userId>`이고, 값은 음이 아닌 안전 정수만 씁니다. 형식이 틀리면 삭제합니다.
- sessionStorage·IndexedDB는 0건입니다.
- CSRF token은 클로저 메모리에만 있고 401이면 비웁니다.
- 서비스 워커
  - `/api`·WS·비GET·교차 출처 요청을 우회합니다.
  - 런타임 캐싱 없이 precache만 하고, 탐색 요청은 network-first입니다.
  - 캐시 이름이 목록 해시라 버전이 바뀌면 이전 캐시를 삭제합니다.
  - 해시 없는 셸 파일로 생기는 위험은 network-first와 `cache:'reload'`(`sw.ts:28`)로 막습니다.
- 초대 token
  - `useState` 메모리에만 둡니다.
  - 마운트 즉시 `history.replaceState`로 URL 해시를 지웁니다(`InviteAccept.tsx:46,57-60`).
- 401·계정 전환
  - `end('unauthorized')`·`adoptAccount`·`clearCheckpoints`가 실행됩니다(`data/http-source.ts:144-166,378`).
  - signed-out이 되면 AppShell이 언마운트되고 WS를 닫습니다.
  - 관찰: 로그아웃 UI를 부르는 곳이 아직 없습니다(P0 UI 스펙 범위 밖).

**6. 로그·계측 누출**
- 로거 설정
  - Fastify는 `logger:false`(`app.ts:125`)입니다.
  - ops 로거는 허용 필드만 남기고 200자 상한을 둡니다(`ops/logger.ts:5-35`).
  - 라우트는 패턴만 기록하고, `request_id`는 서버가 만든 UUID입니다.
- 오류 처리기는 `{code, request_id}`만 응답하고 stack·SQL은 싣지 않습니다(`app.ts:136-140`, `errors.ts:24-31`). 예외는 F-5입니다.
- `console.*` 사용
  - 서버·웹·shared 소스 모두 0건입니다.
  - CLI는 고정 문구와 SQLSTATE만 출력합니다(`bin/lib/cli.ts:76-88`).
- `check:log-leak`은 int 테스트 stdout·stderr와 HTTP·WS·CLI 카나리아를 덮습니다. 운영 stdout 파일과 PG 로그는 NC-22 QA 범위입니다.

**7. 운영 경계**
- 바인드
  - `HOST`가 정확히 `127.0.0.1`이 아니면 기동을 거부합니다(`bind.ts:12-16`).
  - listen 뒤 실제 주소를 다시 검사합니다(`bind.ts:39-46`).
  - 이 값을 우회하는 다른 env 경로는 없습니다.
  - `bind.int.test.ts`가 통과합니다.
- `bootstrap-owner`·`reset-password` 비밀번호 입력
  - TTY echo를 끄고 받거나 stdin 첫 줄로만 받습니다. argv·env로는 받지 않습니다(`secret-input.ts:18-66`).
  - 원격 라우트에서 import하지 않습니다.
- 복원 드릴 자격 증명과 덤프
  - `umask 077`, `mktemp -d` 아래 600 권한 env 파일을 `docker exec --env-file`로만 넘깁니다. argv·출력에는 넣지 않습니다(`restore-drill.sh:7,43-45`).
  - 덤프는 trap에서 삭제합니다.
  - 테스트 DB 가드: 호스트는 127.0.0.1/localhost, DB 이름은 `_test` 접미사, role은 `ohmyslack_test`, 스키마 이름은 정규식으로 제한합니다(`tools/assert-test-db.ts:13-34`, `restore-drill/cli.ts:23-33`).
- CI(`.github/workflows/ci.yml`)
  - `permissions: contents: read`입니다.
  - `pull_request` 트리거이고 `pull_request_target`이 아닙니다.
  - 비밀은 CI 전용 더미 PG 비밀번호뿐입니다.
  - action은 `@v4` 태그로만 고정돼 있습니다. SHA 고정은 없어 TM-SUP-03 Low가 유지됩니다(NC-27).

**8. 의존성**
- `pnpm audit --prod`: **No known vulnerabilities**(EXIT=0)
- `pnpm audit`(dev 포함): moderate 1건. `minimatch >=7 <11.0.1`, eslint 경유, GHSA-g3hv-75wg-m249
- 신규 직접 의존성: P1 기준점 `98bf91c` 대비 `@fastify/websocket 11.3.7` 1개입니다(정확한 버전 고정). `git diff 98bf91c -- */package.json`으로 확인했습니다.
- 직접 의존성은 전부 정확한 버전으로 고정돼 있습니다.
  - server: `@fastify/cookie 11.1.5`, `@fastify/websocket 11.3.7`, `fastify 5.12.8`, `pg 8.23.1`, `zod 4.6.7`
  - web: `react`·`react-dom 19.3.1`
  - shared: `zod 4.6.7`
- argon2는 Node 26 내장이라 외부 의존성이 없습니다. 빌드 스크립트는 `onlyBuiltDependencies: esbuild`만 허용합니다.

## 3. THREAT_MODEL 잔여 위험 Medium 13건 현재 상태

| ID | 위협 | 상태 | 근거 |
|---|---|---|---|
| TM-WEB-02 | `/api` 응답이 HTTP 디스크 캐시에 남음 | **해소(부분)** | S5 `no-store`(`security.ts:76`). 퍼센트 인코딩 우회는 F-4 Low |
| TM-WEB-06 | 이름류 XSS | **해소** | JSX 텍스트로만 렌더, 위험 sink 0, S6 CSP |
| TM-HTTP-03 | 쿠키 속성 오설정 | **해소** | `__Host-` 접두사, Secure 상수, 옵션 거부(`app.ts:84-90`), `cookie-attrs.int.test.ts` 통과. Serve HTTPS 실측은 QA |
| TM-HTTP-05 | 로그인 제한이 출처 IP로 퇴화 | **해소** | S1 계정·전역 키, IP·헤더 미사용, 직렬 큐 |
| TM-HTTP-08 | 초대 수명·폐기·시도 제한 | **해소(부분)** | 72시간·CSPRNG·SHA-256·revoke 라우트·원자적 1회 사용. 수락 시도 제한은 없고, 이메일 열거는 F-3 Low |
| TM-HTTP-16 | 자격 증명 복구 뒤 세션 유지 | **해소(부분)** | DB 세션 전부 폐기. CLI 경로 WS close 미충족은 F-2 Low |
| TM-DB-01 | PG 포트 LAN 노출 | **해소(사실 확인)** | S13: `127.0.0.1:5432`(2026-11-07 `docker port`), `TAILSCALE_SERVE.md:32`. 저장소 밖이라 QA에서 재확인 |
| TM-DB-04 | PG 서버 로그에 이메일·본문 | **유지** | shared-infra 설정 사안(needs_validation). 대부분의 unique 충돌은 `ON CONFLICT`로 흡수됨 |
| TM-LOG-02 | 로거를 거치지 않는 출력 | **유지** | `console` 0, `logger:false`. 다만 `pg.Pool` error 리스너가 없어 크래시 시 raw stack이 나오고, 운영 stdout 파일 수집 정책이 없음(H-3) |
| TM-BAK-01 | 백업 보존·권한·암호화 | **유지** | PRD ⚖️-3 미결. 드릴 덤프는 700 디렉터리, 종료 시 삭제 |
| TM-BAK-02 | 복원으로 세션·초대·계정 부활 | **유지** | S12는 결정됐지만 미구현(F-6 Low). 운영 복원은 승인 전 미실행 |
| TM-MAC-02 | 맥 사용자 권한 악성 프로세스 | **유지(수용)** | 앱 범위 밖. `RESTORE_DRILL.md:68`에 FileVault 권고 기재 |
| TM-SUP-02 | 개발 의존성 취약점 | **유지** | dev moderate 1건(minimatch, eslint 경유). `--prod` 0건 |

악화된 항목은 없습니다. 해소 4, 부분 해소 3, 사실 확인으로 해소 1, 유지 5(수용 1 포함)입니다.

## 4. 이전 리뷰 지적의 해결 여부

중복 지적은 하지 않고 해결 여부만 확인했습니다.

| 출처 | 지적 | 상태 |
|---|---|---|
| p1-w06a-review r1 P1 | 동시 로그인으로 S1 우회 | 해결(`c2f5f80`, 직렬 큐 유지) |
| p1-w06a-review r2 P1 | 빌드된 dist에서 shared의 zod 미해석 | 해결(`7b83c00`, `apps/server/package.json` `zod 4.6.7`) |
| p1-w09b-review P1 | replay 도중 퇴장해도 본문 전송 | 해결(`38518a6`, `hub.ts:211-230` 재확인) |
| p1-w09b-review P2 | 답글 수 live 팬아웃 | 보안 무관(기능), 이월 상태 유지 |
| p1-ops-server r1 P2 | 계측 문자열 enum | 해결(`0796068`) |

## 5. needs_validation (심각도 없음, 배포·QA 확인 필요)

1. **정적 UI 서빙 코드가 없습니다.** `GET /`이 404 JSON입니다. 그래서 `index.html`·`sw.js`·`/assets/*`에 S6 헤더가 붙는지 지금 검증할 수 없습니다. 서빙을 추가할 때는 같은 root 인스턴스에 등록하고, 헤더 테스트에 `GET /`·`/sw.js`를 추가해야 합니다.
2. **Host 헤더:** Serve가 전달하는 Host가 `ALLOWED_ORIGIN` 호스트와 정확히 일치하는지 확인해야 합니다(`:443` 포함 여부).
3. **브라우저 동작:** 다음 세 가지를 QA에서 확인해야 합니다.
   - iOS Safari·PWA가 같은 출처 POST·PUT·PATCH·DELETE에 `Origin`을 보내는지
   - CSP `connect-src 'self'` 아래에서 `wss://` 연결이 되는지
   - 실제 Set-Cookie 속성(NC-08 QA)
4. **HSTS:** Serve 쪽 주입 여부를 확인해야 합니다(S6 요구 항목은 아님).
5. **빌드 산출물:** `dist/index.html`에 inline script가 없는지 확인해야 합니다. 소스 기준으로는 없습니다.
6. **CLI 원격 DB:** `bootstrap-owner`·`reset-password`는 셸의 `DATABASE_URL`을 호스트 가드 없이 그대로 씁니다. 실수 위험은 운영 환경에 달려 있습니다.
7. **PG 서버 로그 설정:** TM-DB-04 참조.

## 6. 수정 레인 지시안 (Jarvis용)

PASS 판정이라 차단 요소는 아닙니다. G1 전에 아래 레인으로 정리할 것을 권고합니다.

| 레인 | 범위(쓰기 경로) | 항목 | 완료 기준 |
|---|---|---|---|
| fix-w15-web | `apps/web/src/features/conversation/{render.ts,MessageBody.tsx,MessageItem.tsx}`, `apps/web/test/conversation/` | F-1 | 4000자 악성 입력 2종 각각 `parseBody` 20 ms 이하. 기존 렌더·링크 테스트 GREEN. RED→GREEN 기록 |
| fix-w15-http | `apps/server/src/{app.ts,http/security.ts,http/access.ts}`, `modules/sync/routes.ts`, `modules/members/routes.ts`, `apps/server/test/http/` | F-4, F-5, H-1, H-2 | `/%61pi/healthz`가 no-store. `/%zz`가 S6 헤더와 `invalid_request`. 가드 없는 account 라우트면 기동 실패. 대문자 self UUID면 409 |
| fix-w15-auth | `apps/server/src/modules/{realtime/hub.ts,members/repo.ts}`, `apps/server/src/main.ts`(LISTEN을 택한 경우), `apps/server/test/{ops,members}/`, `docs/runbooks/BOOTSTRAP_OWNER.md` | F-2, F-3 | `credential-reset.int.test.ts`에서 훅 없이 reset하면 5초 안에 1008. 기존 이메일로 수락하면 token이 소모됨. 런북 51행 갱신 |
| fix-w15-ops-doc | `docs/runbooks/RESTORE_DRILL.md`, `tools/restore-drill/compare.ts`(선택) | F-6 | 서비스 재개 전 세션·미사용 초대 무효화 단계와 대조 항목 추가 |

공통 조건
- `pnpm verify` EXIT=0
- Codex `/codex:review` 통과
- `dev/active/`는 커밋하지 않음
