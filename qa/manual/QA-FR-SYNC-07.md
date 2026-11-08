# QA-FR-SYNC-07 — iPhone 웹 앱 5분 백그라운드 후 복귀 (DEV_DESIGN 6-2 FR-SYNC-07, 5-4 형식)

> 기준: PRD FR-SYNC-07 + 디자인 §6-4 연결 상태 매트릭스. 수동 열 "iPhone PWA 5분 백그라운드 후 복귀". 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).

| 필드 | 값 |
|---|---|
| 실행자 | Aside(computer-use: iPhone 미러링 + Mac Safari, 계정 b는 API) |
| 일시(KST) | 백그라운드 2026-11-08 17:39:57 → 복귀 17:45:01 KST (5분 3초) |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) macOS 27.2 + Safari 27.2 / **iPhone 16 Pro(실기, 뷰포트 402pt)** iOS Safari·홈 화면 웹 앱 — Mac「iPhone 미러링」으로 조작(입력은 Mac 키보드=하드웨어 키보드 경로, 탭=미러링 클릭) |
| 접속 경로 | tailnet HTTPS `https://<host>.<tailnet>.ts.net:8443`(tailscale serve, Funnel 끔) → 로컬 테스트 서버(127.0.0.1, 테스트 DB 실행별 스키마, 계정 a·b 시드), 웹 빌드 `feat/w16-keymap-focus` `69d1078` dist. 운영 서버·운영 DB 미사용 |
| 절차 | 웹 앱에서 `#kb-gamma`(메시지 4건)를 연 채 홈으로 이동(백그라운드). 그동안 ① b가 `kb-gamma`에 105건 게시 ② b가 `kb-gamma 메시지 2` 수정 ③ b가 `kb-gamma 메시지 4` 삭제 ④ b가 `kb-alpha`·`kb-beta`에 새 메시지 ⑤ 다른 기기(Mac Safari·iOS Safari, 같은 계정 a)가 `kb-alpha`·`kb-beta`를 읽음. 5분 경과 후 웹 앱 아이콘으로 복귀, 6초 동안 약 75ms 간격 캡처 → 목록·이력 맨 위까지 확인 |
| 기대 결과 | 유효 세션 확인·재연결·cursor catch-up 후 105건·수정·삭제·다른 기기 읽음이 반영되고, 완료 전에는 최신으로 표시하지 않음. 상태 문구는 §6-4(catch-up 중 「최신 상태 확인 중…」, 배지·구분선·굵게 갱신 보류) |
| 실제 결과 | **데이터 수렴은 기대대로:** 로그인 요청 없음(유효 세션). 340ms 프레임은 이전 화면(메시지 1–4) + 배너 「다시 연결 중…」, 959ms에 `bulk 100–105`가 그려짐(배너 유지), 2,874ms에 배너 사라짐. 이력 맨 위 `kb-gamma 메시지 2 (백그라운드 중 수정됨)`+「(수정됨)」, 메시지 4 자리 「삭제된 메시지입니다」, `bulk 1`–`bulk 105` 연속. 목록은 `kb-alpha`·`kb-beta`(다른 기기 읽음)·`kb-gamma`(열려 있음) 모두 보통 굵기로 서버와 일치. 프로세스는 유지된 채 복귀(재로드 아님). **문구 차이(F-5):** 복귀 6초 동안 「최신 상태 확인 중…」은 한 프레임도 보이지 않고 「다시 연결 중…」만 약 2.9초 표시. 소스상 `resume()`이 `catching-up`을 켠 뒤(`apps/web/src/data/http-source.ts:752`) 늦게 온 WS `onClose`가 `reconnecting`으로 덮어씀(`:497`). 사이드바·스레드 보류는 `connection === 'catching-up'`일 때만 켜지므로(`features/layout/AppShell.tsx:461`, `:466`) catch-up 도중 보류가 풀릴 수 있음(추정, 이번 화면에서 배지 깜빡임은 관찰 못 함). **미실행:** 서버 불가 상태에서 복귀 |
| 판정 | `미검증` — 5분 복귀 후 데이터·읽음 수렴은 통과. 다만 §6-4 「최신 상태 확인 중…」 상태가 관찰되지 않아(F-5) 문구·보류 규칙을 통과로 적지 않음. 서버 불가 경로도 남음 |
| 증거 경로 | `reports/qa/sync-07/` — `resume-frames-grid.png`(340·959·1034·2789·2874·3026·3738·6339ms), `resume-banner-crops.png`, `resume-{340,959,2789,2874}.png`, `history-top-edit-delete.png`, `list-after-resume.png` (gitignore, 로컬 보관) |
