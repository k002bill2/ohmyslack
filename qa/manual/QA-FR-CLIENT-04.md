# QA-FR-CLIENT-04 — 실기 저장소 검사·로그아웃 후 재노출 (DEV_DESIGN 6-2 FR-CLIENT-04, 5-4 형식)

> 기준: PRD FR-CLIENT-04 + B7. 수동 열: "실기 저장소 검사, 로그아웃 후 뒤로·앞으로·페이지 복원에서 본문 재노출 0".
> 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).

| 필드 | 값 |
|---|---|
| 실행자 | Claude(W-16 QA 레인, ego-browser 자동 조작) — Safari·iPhone 부분은 미실행 |
| 일시(KST) | 2026-11-08 12:11–12:12 KST |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) / macOS 27.2 / ego-browser 0.6.2.9 (Chromium 156.0). macOS Safari·iOS Safari·홈 화면 PWA 미실행 |
| 접속 경로 | localhost(`http://127.0.0.1:<임의 포트>`, 커밋 74b822e 빌드, Service Worker 활성) |
| 절차 | ① 로그인 후 두 채널을 열어 본문 로드 ② 페이지 안에서 localStorage·sessionStorage·IndexedDB 목록·Cache Storage 전 항목(텍스트 응답은 본문까지)을 읽어 마커(메시지 본문 4종·이메일·`csrf`·표시 이름) 검색, SW 등록 확인 ③ `로그아웃` ④ 같은 검사 반복 ⑤ `history.back()`×2, `history.forward()`×2, `about:blank` 이동 후 back(bfcache 복원), reload — 매번 화면 텍스트에서 마커 검색·스크린샷 |
| 기대 결과 | 저장소에 본문·인증 응답 없음(숫자 checkpoint만 예외, B7), Cache Storage에 `/api/` 없음, 로그아웃 후 뒤로·앞으로·페이지 복원·새로고침에서 본문 재노출 0 |
| 실제 결과 | **로그인 중:** localStorage = `oms.cp.<id>`: `"13"` 1개(숫자 checkpoint)뿐, sessionStorage 0, IndexedDB 0, Cache Storage `oms-shell-*` 11항목(index.html·JS·CSS·아이콘·manifest)·`/api/` 0 · 마커 적중 `csrf` 1건 — 캐시된 JS 번들 코드의 필드명 문자열 `csrf_token`(데이터 아님, `apps/web/dist/assets/index-*.js` 1회) · SW `/sw.js` 활성. **로그아웃 후:** `/login`, localStorage 비어 있음(checkpoint도 삭제), 캐시 동일(셸만). **이동 6회**(back→`/c/<id>`, back→`/`, forward→`/c/<id>`, forward→`/login`, bfcache 복원, reload) 모두 로그인 폼만 표시·화면 마커 0 |
| 판정 | `미검증` — 데스크톱 Chromium에서는 기대와 일치. bfcache·저장소 동작이 다른 macOS Safari·iOS Safari·홈 화면 PWA 실기 확인이 남아 있어 PASS로 적지 않음 |
| 증거 경로 | `reports/qa/client-04/storage-and-nav.json`, `reports/qa/client-04/{back1,back2,forward1,forward2,restoreFromBfcache,reload}.png` — `reports/`는 gitignore(로컬 보관). 자동 증거: `pnpm check:no-persist-cache`(W-16 verify 통과) |

## 2차 실행 — macOS Safari·iOS Safari·홈 화면 웹 앱 (2026-11-08 17:46–17:53 KST)

| 필드 | 값 |
|---|---|
| 실행자 | Aside(computer-use: Mac Safari + iPhone 미러링) |
| 기기·OS·브라우저(버전) | macOS 27.2 Safari 27.2 / iPhone 16 Pro iOS Safari·홈 화면 웹 앱 |
| 접속 경로 | tailnet HTTPS `:8443` → 로컬 테스트 서버(테스트 DB), 빌드 `69d1078` |
| 절차 | 로그인 후 채널 본문을 연 뒤 `로그아웃`. macOS Safari: `⌘[`×3 → `⌘]`×3 → `⌘R` → `about:blank` 이동 후 뒤로(bfcache 복원), 매번 접근성 트리에서 본문 마커(메시지 본문 6종) 검색. iOS Safari: 툴바 뒤로×3 → 앞으로×3 → 새로고침, 매번 캡처. 웹 앱: (a) Safari 로그아웃으로 같은 세션 폐기 후 복귀·강제 종료 재실행 (b) 웹 앱 안에서 `로그아웃` → 가장자리 밀기 → 홈 갔다 복귀 → 강제 종료 재실행 |
| 실제 결과 | **macOS Safari:** 로그아웃 후 9회 이동(`/settings/members`·`/c/<id>` 2곳·`/login`, bfcache 복원 포함) 모두 로그인 폼, 본문 마커 0. **iOS Safari:** 뒤로 3회·앞으로 3회·새로고침 모두 로그인 폼만, 본문 노출 0. **웹 앱:** (a) 복귀 시 「세션이 종료되었습니다. 다시 로그인해 주세요.」, 재실행도 로그인 폼 (b) 로그인 폼 유지, 본문 노출 0. 미러링 드래그는 가장자리 뒤로 제스처가 아니라 텍스트 선택으로 처리돼 standalone 뒤로 제스처는 확인 못 함. **미실행:** Safari·iOS 저장소 검사(Web Inspector 필요) |
| 판정 | `미검증` — 세 환경 모두 로그아웃 후 재노출 0. 실기 저장소 검사(localStorage·Cache Storage·IndexedDB)와 웹 앱 가장자리 뒤로 제스처가 남음 |
| 증거 경로 | `reports/qa/client-04-safari-ios/` — `ios-safari-back3.png`, `ios-safari-fwd3-reload.png`, `pwa-logout-swipe-resume-relaunch.png`, `pwa-relaunch-after-external-revoke.png`. macOS Safari는 위 표의 AX 검사 결과(이동별 URL·마커 수) |

## 3차 실행 — 실기 저장소 검사: iOS Safari·macOS Safari (2026-11-09 00:13–00:20 KST)

| 필드 | 값 |
|---|---|
| 실행자 | Claude(orca computer: iPhone은 Mac 「iPhone 미러링」 앞 창 조작, macOS Safari는 접근성 조작 + AppleScript 주소 이동) |
| 기기·OS·브라우저 | iPhone 16 Pro 실기 iOS Safari 탭 / macOS 27.2 Safari **개인정보 보호 창**(같은 호스트의 운영 세션 쿠키 `__Host-oms_session`을 덮어쓰지 않으려고 사용) |
| 빌드·접속 | main `6b487e2` `pnpm -r build`. verify 런 스키마에 붙은 QA 서버(127.0.0.1)를 `tailscale serve --https=8443`(tailnet only)로 노출. dist 복사본에 저장소 밖 진단 페이지 `qa-storage.html`·`qa-storage.js`만 추가(앱 코드·번들 무변경). 끝난 뒤 serve 8443 off·서버 종료·스키마 DROP |
| 절차 | ① owner 로그인, 마커 본문(`QAMARKA1–3`·`QAMARKB1–3`)이 있는 두 채널을 열어 본문 로드 ② 같은 출처 진단 페이지에서 localStorage·sessionStorage 전 항목, `indexedDB.databases()`, Cache Storage 전 항목(텍스트 응답은 본문까지)을 읽어 마커(`QAMARK`·이메일·표시 이름 `검증 오너`·`csrf`) 검색, SW 등록·`document.cookie` 확인 ③ 앱으로 돌아가 `로그아웃` ④ 같은 검사 반복. 1차(Chromium)와 같은 페이지 내 검사 방식 |
| 기대 결과 | 저장소에 본문·인증 응답 없음(숫자 checkpoint만 예외, B7), Cache Storage에 `/api/` 없음, 로그아웃 후 checkpoint까지 삭제 |
| 실제 결과 | **iOS Safari 로그인 중:** localStorage `oms.cp.<id>` = `6` 1개, sessionStorage 0, IndexedDB 0, Cache Storage `oms-shell-*` 4개 44항목·`/api` 0, SW `/sw.js` active, `document.cookie` 0(세션 쿠키는 HttpOnly). 마커 적중은 `csrf` 4건뿐 — 캐시된 JS 번들 4개의 필드명 문자열 `csrf_token`(데이터 아님, 1차와 같음). 셸 캐시 4개는 이날 빌드한 이전 버전들로, **로그아웃 후 검사 때는 새 SW 활성화로 1개(`oms-shell-ycsw6c` 11항목)만 남음**(정리 동작 정상). **iOS Safari 로그아웃 후:** localStorage 0(checkpoint 삭제), sessionStorage 0, IndexedDB 0, 캐시 1개·`/api` 0, 마커 적중 `csrf` 1건(번들 코드). **macOS Safari 로그인 중:** localStorage `oms.cp.<id>` = `6` 1개, sessionStorage 0, IndexedDB 0, 캐시 1개 11항목·`/api` 0, 마커 적중 `csrf` 1건(번들 코드). **macOS Safari 로그아웃 후:** localStorage 0, 나머지 동일. 본문·이메일·표시 이름 마커는 모든 검사에서 0건 |
| 판정 | `미검증` — iOS Safari 탭·macOS Safari 저장소 검사는 기대와 일치(로그아웃 후 재노출 0은 2차에서 확인). 남은 것: **홈 화면 웹 앱** 저장소(Safari 탭과 별도 저장 공간이고 주소창이 없어 진단 페이지를 열 수 없음 — Web Inspector 필요)와 웹 앱 가장자리 뒤로 제스처(실제 손가락). macOS Safari는 개인정보 보호 창이라 일반 창의 영구 저장소와 다를 수 있음 |
| 증거 경로 | `reports/qa/client-04-iphone-storage/` — `01-qa-c4a.png`, `02-qa-c4b.png`, `03-storage-logged-in.png`, `05-after-logout.png`, `06-storage-logged-out.png`, 진단 페이지 원본 `qa-storage.{html,js}`, `qa-server.log` · `reports/qa/client-04-macos-safari/` — `storage-logged-{in,out}.{txt,png}` — `reports/`는 gitignore(로컬 보관) |

## 4차 실행 — 홈 화면 웹 앱 저장소(Web Inspector)·가장자리 뒤로 제스처 (2026-11-09 KST, 실기)

| 필드 | 값 |
|---|---|
| 실행자 | 영환님(실기, 실제 손가락) — 기록: Jarvis(회신 원문 인용) |
| 일시(KST) | 2026-11-09 21:08(저장소 회신)·21:1x(제스처 포함 「CLIENT-04 통과」 회신) |
| 기기·OS·브라우저(버전) | iPhone 16 Pro / iOS 18.7 / 홈 화면 웹 앱(standalone) + Mac Safari 「개발」 메뉴 Web Inspector |
| 접속 경로 | tailnet Serve HTTPS(`https://<tailnet-host>`) → 운영 서버(`127.0.0.1:8787`, launchd `com.ohmyslack.server`), 서버 빌드 `b655ddd`(번들 `index-B5U0qDQE.js`) |
| 절차 | 체크리스트 `dev/handoff/qa/DEVICE-CHECKLIST-G1.md` 8·9번: ① 웹 앱 로그인 후 채널 두 개 본문 로드 ② Web Inspector 저장 공간 탭에서 Local Storage·Session Storage·IndexedDB·Cache Storage 검사(본문·이메일·표시 이름·csrf 값, Cache Storage `/api/`) ③ 웹 앱에서 `로그아웃` ④ 같은 검사 반복 ⑤ 다시 로그인 → 채널 본문 열기 → `로그아웃` → 화면 왼쪽 가장자리에서 오른쪽으로 밀기(뒤로) 2–3회 |
| 기대 결과 | ②④ 저장소에 본문·인증 응답 없음(숫자 checkpoint만 예외, B7), Cache Storage에 `/api/` 없음 ⑤ 로그인 화면만 보이고 이전 본문 재노출 0 |
| 실제 결과 | ②④ 회신 `CLIENT-04 웹앱 저장소 본문 0 (로그아웃 전·후)` ⑤ 회신 `CLIENT-04 통과`(체크리스트상 남은 항목이 9번 제스처뿐이었으므로 제스처 본문 0으로 기록). 1–3차 결과(데스크톱 Chromium·macOS Safari·iOS Safari 탭 저장소 검사, 세 환경 로그아웃 후 뒤로·앞으로·복원·재실행 재노출 0)와 합쳐 수동 열 전 환경 충족 |
| 판정 | `PASS` — 실기 저장소 검사(Chromium·macOS Safari·iOS Safari·홈 화면 웹 앱)와 로그아웃 후 재노출 0(뒤로·앞으로·페이지 복원·새로고침·재실행·웹 앱 가장자리 뒤로)을 모두 확인. 근거 수준: 4차는 L2(영환님 실기 회신, 스크린샷 미첨부), 1–3차는 L1 |
| 증거 경로 | 회신 원장 `dev/handoff/qa/DEVICE-RESULTS-G1.md`(gitignore, 로컬), 1–3차 `reports/qa/client-04*/`(gitignore, 로컬). 자동 증거: `pnpm check:no-persist-cache` |
