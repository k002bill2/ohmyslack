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
| 판정 | `미검증` — 측정한 데스크톱 22조합은 기대와 일치. 소수 폭 640.5·1023.5px 실제 렌더와 iPhone Safari 390px 실기(S2·S4·S6, 가상 키보드 가림)가 남아 있어 PASS로 적지 않음 |
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
| 원인 가설(L2, 코드 확인) | `conversation.css:463` — 「메시지 작업」 버튼은 `.msg-item:focus-within`일 때만 보이고 그 외에는 1px로 접힘. iOS WebKit은 버튼을 탭해도 버튼에 포커스를 주지 않으므로, 탭 순간 항목이 포커스를 잃어 버튼이 접히고 레이아웃이 줄어든 자리(아래 메시지)로 클릭이 떨어지는 것으로 보임. 데스크톱 Chromium은 클릭한 버튼에 포커스를 주므로 재현되지 않음(1차 데스크톱 통과와 일치). → QA_REPORT F-7을 「확인 필요」에서 **결함 가능성 높음**으로 올림. 실제 손가락으로도 같은지 확인 필요 |
| 판정 | `미검증` 유지 — S2 수정·삭제를 미러링으로 완료하지 못함. 길게 누르기(실제 손가락)·가상 키보드 가림·640.5/1023.5px 렌더가 남음 |
| 증거 경로 | `reports/qa/client-02-mirroring/` — `01-tap-message.png`, `02-tap-actions.png`(탭 후 메시지 3 활성), `03-tap-actions-again.png`, `04-longpress-drag.png`, `05-keyboard-sheet.png`, `06-edit-key.png`, `07-logged-out.png` — `reports/`는 gitignore(로컬 보관) |
