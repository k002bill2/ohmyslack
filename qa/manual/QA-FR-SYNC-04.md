# QA-FR-SYNC-04 — 맥·iPhone 동시 전경 읽음 수렴 (DEV_DESIGN 6-2 FR-SYNC-04, 5-4 형식)

> 기준: PRD FR-SYNC-04 + 수동 열 "맥·iPhone 동시 전경, S6 배지 갱신". 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).

| 필드 | 값 |
|---|---|
| 실행자 | Aside(computer-use: Mac Safari + iPhone 미러링) |
| 일시(KST) | 2026-11-08 17:38–17:43 KST |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) macOS 27.2 + Safari 27.2 / **iPhone 16 Pro(실기, 뷰포트 402pt)** iOS Safari·홈 화면 웹 앱 — Mac「iPhone 미러링」으로 조작(입력은 Mac 키보드=하드웨어 키보드 경로, 탭=미러링 클릭) |
| 접속 경로 | tailnet HTTPS `https://<host>.<tailnet>.ts.net:8443`(tailscale serve, Funnel 끔) → 로컬 테스트 서버(127.0.0.1, 테스트 DB 실행별 스키마, 계정 a·b 시드), 웹 빌드 `feat/w16-keymap-focus` `69d1078` dist. 운영 서버·운영 DB 미사용 |
| 절차 | 같은 계정 a로 기기 A=Mac Safari, 기기 B=iPhone(① 홈 화면 웹 앱 ② iOS Safari) 동시 전경. 계정 b(API)가 `kb-beta`에 원문 + a 멘션 답글을 남김 → B 사이드바에 굵게·`↳`·멘션 `1` 확인. A에서 ① `kb-beta` 열기(본문 읽음) ② 원문 `답글 1 새 답글` 열기(스레드·멘션 읽음). 클릭 직후부터 B 화면을 약 70–100ms 간격으로 캡처해 변화 시점 측정 |
| 기대 결과 | 서버 읽음 저장 후 2초 안에 B의 본문·스레드·멘션 상태가 A와 일치, 스레드 unread는 본문 굵게/수에 합산되지 않음 |
| 실제 결과 | **웹 앱(B①):** A `kb-beta` 클릭 후 1,040ms 프레임까지 굵게 → **1,118ms 프레임에서 보통 굵기**, 이때 `↳`·멘션 `1`은 그대로(스레드는 본문에 합산·소거되지 않음). A 스레드 열기 후 1,390ms 프레임까지 `↳ 1` → **1,493ms 프레임에서 둘 다 사라짐**. **iOS Safari(B②):** A `kb-beta` 클릭 후 1,261ms → **1,351ms 프레임에서 보통 굵기**. 사전 확인으로 `kb-alpha`도 같은 방식으로 B에서 해제됨. 측정값은 A 클릭 시작 기준이라 클릭 처리·`PUT /api/read-state`·WS 전달·미러링 화면 지연을 모두 포함한 상한 |
| 판정 | `PASS` — 본문·스레드·멘션 모두 2초 안(최대 1.5초)에 일치, 스레드 unread 비합산 확인. 방향은 Mac→iPhone만 측정 |
| 증거 경로 | `reports/qa/sync-04/` — `pwa-before-thread-mention.png`, `pwa-main-read-{1040ms-before,1118ms-after}.png`, `pwa-thread-read-{1390ms-before,1493ms-after}.png`, `safari-main-read-{1261ms-before,1351ms-after}.png` (gitignore, 로컬 보관) |
