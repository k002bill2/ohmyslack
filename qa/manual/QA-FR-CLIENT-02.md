# QA-FR-CLIENT-02 — 구간별 단수·가로 넘침·compact 이동 (DEV_DESIGN 6-2 FR-CLIENT-02, 5-4 형식)

> 기준: PRD FR-CLIENT-02 + 디자인 §5·§8·§11-1·§11-2. 수동 열: "정본 §11 QA 폭 목록 전부 가로 넘침 0, iPhone 390px S2·S4·S6, 가상 키보드 가림 0".
> 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).

| 필드 | 값 |
|---|---|
| 실행자 | Claude(W-16 QA 레인, ego-browser 자동 조작) — iPhone 부분은 미실행 |
| 일시(KST) | 2026-11-08 12:07–12:08 KST |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) / macOS 27.2 / ego-browser 0.6.2.9 (Chromium 156.0), CDP `Emulation.setDeviceMetricsOverride`(높이 800, DSF 1). iPhone Safari 미실행 |
| 접속 경로 | localhost(`http://127.0.0.1:<임의 포트>`, 커밋 74b822e 빌드) |
| 절차 | ① 폭 320·390·640·641·768·1023·1024·1119·1120·1280·1440px × 스레드 닫힘/열림마다 새로 로드 → 채널 진입·메시지 렌더 대기(긴 무공백 단어 1건 포함) ② `documentElement.scrollWidth`·사이드바/스레드 사각형·작성기·전송 버튼이 뷰포트 안인지 측정, 스크린샷 ③ compact(320·390·640): 목록 → 채널 → `메시지 작업` 시트 → `답글` → 스레드, 브라우저 back → 본문, `뒤로` → 목록 |
| 기대 결과 | compact(≤640) 1단, medium(640<w<1024) 2단·스레드 오버레이 `min(420px,100%)`·`aria-modal`, wide(≥1024) 3단·스레드 `clamp(320,32vw,380)`, 스레드 열림+1024–1119px 사이드바 72px 접힘·본문 ≥480, 1120px 펼침 복귀, 전 폭 가로 넘침 0·작성기/전송 가림 0, compact 공간→본문→스레드→뒤로. iPhone 390px S2·S4·S6·가상 키보드 가림 0 |
| 실제 결과 | **데스크톱 Chromium 22조합 전부 기대대로:** 가로 넘침 0(scrollWidth = 뷰포트 폭) · 작성기·전송 버튼 전부 뷰포트 안 · 320/390/640 사이드바 없음(1단) · 641/768/1023 사이드바 260px + 스레드 오버레이 420px `aria-modal="true"`(2단) · 1024/1119 스레드 열림 시 사이드바 72px·스레드 330/360px·본문 ≥598px · 1120/1280/1440 사이드바 260px·스레드 360/382/382px(테두리 포함) · compact 3폭 모두 시트 버튼 `닫기·답글·수정·삭제·취소` → 스레드(답글 작성기·전송 뷰포트 안, 넘침 0) → back 시 본문 → `뒤로` 시 목록(`/`). **미측정:** 640.5·1023.5px 실제 렌더(CDP 폭은 정수라 재현 불가. `apps/web/test/layout/responsive.test.tsx`는 matchMedia 목으로 구간 분류만 확인하며 넘침·가림은 재지 않음 — 실제 창 폭 조절로 따로 측정 필요), iPhone 실기 390px S2·S4·S6·가상 키보드 |
| 판정 | `미검증` — 측정한 데스크톱 22조합은 기대와 일치. 소수 폭 640.5·1023.5px 실제 렌더와 iPhone Safari 390px 실기(S2·S4·S6, 가상 키보드 가림)가 남아 있어 PASS로 적지 않음. **6차(2026-11-09) 기준 남은 것:** 640.5·1023.5px 실제 렌더만(iPhone 항목은 5차, 390px 정확 폭은 6차 에뮬레이션으로 확인 — 아래 각 절) |
| 증거 경로 | `reports/qa/client-02/widths.json`, `reports/qa/client-02/w<폭>-{closed,thread}.png`(22장) — `reports/`는 gitignore(로컬 보관) |

## 2차 실행 — iPhone 실기 (2026-11-08 17:40–17:52 KST)

| 필드 | 값 |
|---|---|
| 실행자 | Aside(computer-use: Mac「iPhone 미러링」) |
| 기기·OS·브라우저(버전) | iPhone 16 Pro 실기, iOS Safari(뷰포트 402pt — 정본 390px이 아니라 기기 폭). 입력은 Mac 키보드(하드웨어 키보드 경로)라 iOS 가상 키보드가 뜨지 않음 |
| 접속 경로 | tailnet HTTPS `:8443` → 로컬 테스트 서버(테스트 DB), 빌드 `69d1078` |
| 실제 결과 | **S2:** 한글+링크+백틱 메시지 전송 성공, 한글 훼손 없음, 링크 teal 링크로 표시. 이 빌드는 서식(FR-MSG-10) 이전이라 백틱은 그대로 보임(코드 서식 판정 불가). 본인 메시지 수정·삭제는 **미완** — 미러링 탭으로 「메시지 작업」을 누르면 시트가 열리지 않고 목록만 약 70px 움직였고, 미러링 오른쪽 클릭(길게 누르기)도 시트를 열지 못함. 실제 손가락 확인 필요. **S4:** b의 스레드 멘션 답글 → 원문에 「↳ 답글 1 ● 새 답글」, 스레드에서 「나를 멘션」·`@a` 강조 → 뒤로 두 번 후 목록에서 `kb-alpha` 스레드·멘션 표시 해제. **S6:** Mac 읽음 → iOS Safari 1.35초 안에 굵게 해제(QA-FR-SYNC-04). **가로 넘침:** 목록·본문·스레드 화면에서 가로 스크롤·잘림 없음(육안). **관찰:** ① 작성기에 포커스하면 iOS 「자동 완성 연락처」 막대(주소·이름 제안)가 작성기와 전송 버튼을 덮음 — 작성기 `textarea`에 `autocomplete` 지정 없음(`features/conversation/Composer.tsx`) ② 마지막 메시지를 탭하면 펼쳐진 「메시지 작업」 버튼이 작성기 뒤에 가려진 채 자동 스크롤되지 않음 |
| 판정 | `미검증` — S4·S6·S2 전송은 통과. 남은 것: S2 수정·삭제(실제 손가락 길게 누르기/「메시지 작업」), 가상 키보드 가림(미러링으로 재현 불가), 390px 정확 폭(기기는 402pt), 640.5·1023.5px 소수 폭 |
| 증거 경로 | `reports/qa/client-02-iphone/` — `s2-sent-korean-link.png`, `s4-thread-mention.png`, `s4-after-read-list.png`, `composer-autofill-bar.png`, `sheet-trigger-under-composer.png` |

## 3차 시도 — iPhone 미러링으로 S2 수정·삭제 (2026-11-09 00:39–00:41 KST)

| 필드 | 값 |
|---|---|
| 실행자 | Claude(orca computer: Mac 「iPhone 미러링」 앞 창 조작) |
| 기기·OS·브라우저 | iPhone 16 Pro 실기 iOS Safari 탭(compact). 빌드 `b1dd23a`(main `6b487e2` + 문서) |
| 절차 | 본인 메시지 3건 채널에서 ① 메시지 탭 ② 펼쳐진 「메시지 작업」 버튼 탭(2회) ③ 같은 지점 drag(길게 누르기 대용) ④ 하드웨어 키보드 `Tab`·`Enter`·`E` |
| 실제 결과 | ① 메시지 2 탭 → 항목 활성(배경 강조) + 「메시지 작업」 버튼 표시. ② 버튼 탭 → **시트가 열리지 않고** 활성 항목이 아래 메시지 3으로 바뀌며 버튼도 메시지 3 아래로 이동. 다시 탭해도 변화 없음(재현 2/2). ③ drag는 짧은 탭으로 처리되어 500ms 길게 누르기(`LONG_PRESS_MS`) 미발생. ④ `Tab`은 항목에 포커스 링만 주고 버튼으로 가지 않음(iOS Safari 기본 설정은 Tab이 버튼을 건너뜀), `E`도 편집기를 열지 않음(미러링 입력 소스 영향 가능, 원인 미확인) |
| 원인(L1, 이벤트 로그로 확인 — 4차 확인 2026-11-09 01:12–01:16 KST) | **미러링 입력의 부산물이며 앱 결함이 아님.** 같은 출처의 dist 복사본 `index.html`에만 이벤트 기록 스크립트(`qa-evlog.js`, 저장소 밖)를 넣어 탭 순서를 기록함. iPhone 미러링은 탭마다 실제 터치보다 먼저 `pointerdown pt=mouse`·`mousedown`을 **`html`(y=-1)** 에 보낸다. 메시지 2가 포커스된 상태에서 트리거를 탭하면 ① `mousedown tgt=html` → ② `focusout li.msg-item`(트리거가 `:focus-within` 조건을 잃고 접힘) → ③ 실제 터치 `pointerdown pt=touch`가 **메시지 3의 `span.msg-author`(y=289)** 에 도달. 실제 손가락 탭에는 `html`에 대한 이 마우스 이벤트가 없다. 확인 과정에서 트리거에 `onMouseDown` preventDefault를 넣은 빌드도 시험했으나 결과가 같아(가짜 `mousedown`의 대상이 트리거가 아니라 `html`) 수정을 되돌림. 첫 가설(「iOS WebKit은 탭한 버튼에 포커스를 주지 않아 항목이 포커스를 잃음」)은 틀렸음 |
| 판정 | `미검증` 유지 — S2 수정·삭제를 미러링으로 완료하지 못함. 길게 누르기(실제 손가락)·가상 키보드 가림·640.5/1023.5px 렌더가 남음 |
| 증거 경로 | 4차 이벤트 로그 `reports/qa/f7-fix-device/`(`08-log-sequence.png`·`09-log-button-tap.png`·`qa-evlog.js`) · `reports/qa/client-02-mirroring/` — `01-tap-message.png`, `02-tap-actions.png`(탭 후 메시지 3 활성), `03-tap-actions-again.png`, `04-longpress-drag.png`, `05-keyboard-sheet.png`, `06-edit-key.png`, `07-logged-out.png` — `reports/`는 gitignore(로컬 보관) |

## 5차 실행 — 실제 손가락 길게 누르기·가상 키보드 (사용자 실기, 2026-11-09)

| 필드 | 값 |
|---|---|
| 실행자 | 강영환(실기, 실제 손가락) — Claude가 사용자 보고를 기록 |
| 일시(KST) | 2026-11-09 02:10 KST 이전(사용자 보고, 정확한 시각 미기재) · 기록 02:40 KST |
| 기기·OS·브라우저 | iPhone 16 Pro 실기(iOS 버전 미기재), iOS 가상 키보드 |
| 절차 | ① 본인 메시지 길게 누르기 → 「메시지 작업」 시트 → 수정·삭제 ② 작성기 포커스로 가상 키보드를 띄워 작성기·전송 버튼 가림 확인 |
| 실제 결과 | 사용자 보고: ① 길게 누르기로 수정·삭제 「작동됨」 ② 가상 키보드가 작성기·전송 버튼을 「안 가림」. 화면 기록 없음 |
| 판정 | `미검증` 유지 — iPhone 실기 남은 항목(S2 수정·삭제, 가상 키보드 가림)은 이번 보고로 닫힘. 남은 것: 640.5·1023.5px 소수 폭 실제 렌더, 정본 390px 정확 폭(기기는 402pt) — QA 측정 항목 |
| 증거 경로 | 사용자 보고(이 세션 대화, 2026-11-09) |

## 6차 실행 — 소수 폭 시도·390px 에뮬레이션·경계 회귀 (2026-11-09 22:55–23:03 KST)

| 필드 | 값 |
|---|---|
| 실행자 | Claude(p1-g1-client-02 QA 레인, ego-browser 자동 조작) |
| 일시(KST) | 2026-11-09 22:55–23:03 KST |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) / macOS 27.2 / ego-browser(Chromium, 가이드 v2.2.0), CDP `Emulation.setDeviceMetricsOverride`. 390px은 **에뮬레이션**(DSF 3, `mobile:true`, `Emulation.setTouchEmulationEnabled` maxTouchPoints 5, iPhone Safari UA `setUserAgentOverride`) — iPhone 실기 아님 |
| 접속 경로 | localhost(`http://localhost:<임의 포트>`, 빌드 `903441b`, 테스트 DB `ohmyslack_test`의 실행별 스키마 — 종료 시 DROP). 127.0.0.1에 다른 세션 쿠키가 있어 덮어쓰지 않도록 호스트를 `localhost`로 분리 |
| 절차 | ① 합성 채널 `r6-layout`·메시지 4건(긴 무공백 단어 1건 포함)을 UI로 작성(DB 4행 확인) ② 640.5·1023.5 CSS px 뷰포트 만들기 시도: CDP 폭 640.5(DSF 1·2·3), 브라우저 확대 단축키, 같은 출처 iframe `width:640.5px`(+`Page.setBypassCSP`, +`Fetch` 응답 헤더 제거), `setPageScaleFactor`·`scale` ③ 경계 이웃 640·641·1023·1024 × 스레드 닫힘/열림 × DSF 1·2·3(24조합), 1차와 같은 측정(`documentElement.scrollWidth`, `.app-shell[data-layout]`, 사이드바·스레드 사각형, 작성기·전송 버튼 뷰포트 안, 긴 단어 넘침) ④ 390×844 compact: 목록 → 채널 → `메시지 작업` 시트 → `답글` → 스레드 → 브라우저 back → 본문 → `뒤로` → 목록, 단계마다 측정·스크린샷 |
| 기대 결과 | 1차와 같음. 640.5·1023.5 → medium, 640 → compact, 641·1023 → medium, 1024 → wide(스레드 열림 시 사이드바 72px 접힘). 전 조합 가로 넘침 0·작성기/전송 가림 0. 390 compact 흐름 완주·넘침 0 |
| 실제 결과 | **② 소수 폭: 측정 불가(미검증).** CDP `width:640.5`는 DSF 1·2·3 모두 `Invalid parameters`(정수 파라미터). 확대 단축키는 브라우저 크롬에 전달되지 않음(DPR·폭 불변). iframe은 서버 CSP `frame-ancestors 'none'`으로 차단되어 `setBypassCSP`·`Fetch` 헤더 제거로도 열리지 않음(`requestPaused` 0건). `setPageScaleFactor`·`scale`은 레이아웃 폭을 바꾸지 않음. 따라서 640.5·1023.5px 실제 렌더 결과는 **없음**(코드상 구간 질의는 `(640px < width < 1024px)` 범위 문법이라 640.5·1023.5는 medium으로 분류될 것으로 **추정**, L3). **③ 경계 회귀 24조합 전부 기대대로:** 640 compact(사이드바 없음, 스레드 열림 시 640px 전체 화면, 시트 버튼 `닫기·답글·수정·삭제·취소`) · 641·1023 medium(사이드바 260px, 스레드 오버레이 420px `aria-modal="true"`) · 1024 wide(닫힘 사이드바 260px / 스레드 열림 사이드바 72px `data-sidebar=collapsed`, 스레드 329.68px, 스레드 시작 x=682.32) · `scrollWidth` = 뷰포트 폭(넘침 0) · 작성기·전송 버튼 전부 뷰포트 안 · 긴 단어 문단 넘침 0. DSF 1·2·3 결과 동일. **④ 390 에뮬레이션:** innerWidth 390·DPR 3·`pointer: coarse` true·maxTouchPoints 5, 6단계 모두 compact·`scrollWidth` 390(넘침 0), 채널·시트·스레드·back 후 본문에서 작성기·전송 버튼 뷰포트 안, 시트 버튼 `닫기·답글·수정·삭제·취소`, back → 본문, `뒤로` → 목록(`/`) |
| 판정 | `미검증` 유지 — 정본 §11 폭 목록(`DESIGN_REFERENCE.md:550`)의 640.5·1023.5px 실제 렌더를 이 도구로 만들지 못함. 390px은 정확 폭 에뮬레이션으로 compact 흐름·넘침 0 확인(L1, 단 실기 아님 — 실기는 2·5차 iPhone 16 Pro 402pt). 경계 이웃 회귀 없음(L1) |
| 증거 경로 | `reports/qa/client-02-r6/` — `widths.json`(전체 측정 통합), `fractional-probe.json`(소수 폭 시도 기록), `regression-integer.json`·`regression-integer-dsf23.json`, `w{640,641,1023,1024}-dsf{1,2,3}-{closed,thread}.png`(24장), `w390-dsf3-{1-list,2-channel,3-sheet,4-thread,5-back-channel,6-back-list}.png`(6장), `w390-flow.json` — `reports/`는 gitignore(로컬 보관) |
| 남은 것(사람 필요) | 640.5·1023.5px: 실제 Chrome 창에서 확대 200% + 창 내부 폭 1281/2047 DIP(= CSS 640.5/1023.5)로 렌더해 `data-layout`·가로 스크롤 확인. CDP·iframe 경로는 위 사유로 불가 |
