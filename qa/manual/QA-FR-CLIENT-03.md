# QA-FR-CLIENT-03 — iOS 홈 화면 웹 앱 설치·standalone·재실행 (DEV_DESIGN 6-2 FR-CLIENT-03, 5-4 형식)

> 기준: PRD FR-CLIENT-03 + 수동 열 "tailnet HTTPS에서 iOS 홈 화면 추가 → standalone 첫 로그인 → 재실행 시 유효 세션 유지 → S6". 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).

| 필드 | 값 |
|---|---|
| 실행자 | Aside(computer-use: iPhone 미러링, 길게 누르기=미러링 오른쪽 클릭) |
| 일시(KST) | 2026-11-08 17:36–17:52 KST |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) macOS 27.2 + Safari 27.2 / **iPhone 16 Pro(실기, 뷰포트 402pt)** iOS Safari·홈 화면 웹 앱 — Mac「iPhone 미러링」으로 조작(입력은 Mac 키보드=하드웨어 키보드 경로, 탭=미러링 클릭) |
| 접속 경로 | tailnet HTTPS `https://<host>.<tailnet>.ts.net:8443`(tailscale serve, Funnel 끔) → 로컬 테스트 서버(127.0.0.1, 테스트 DB 실행별 스키마, 계정 a·b 시드), 웹 빌드 `feat/w16-keymap-focus` `69d1078` dist. 운영 서버·운영 DB 미사용 |
| 절차 | ① iOS Safari 로그인 상태에서 공유 → 더 보기 → 「홈 화면에 추가」(「웹 앱으로 열기」 켜짐, 이름 `메신저 QA`) ② 아이콘 실행 ③ 앱 전환기에서 위로 밀어 종료 후 재실행 ④ S6: Mac에서 읽음 → 웹 앱 배지 갱신(QA-FR-SYNC-04와 같은 실행) ⑤ Safari에서 로그아웃 → 웹 앱 복귀 ⑥ standalone 로그인 폼으로 다시 로그인 ⑦ 끝난 뒤 홈 화면 아이콘 삭제 |
| 기대 결과 | standalone 실행(브라우저 UI 없음)·설치 안내 숨김, 재실행 시 유효 세션 유지, S6 성공, standalone 첫 로그인 허용 |
| 실제 결과 | ① 시트 아이콘·이름 정상 ② **standalone**(주소창·툴바 없음), Safari에서 보이던 설치 안내 카드 숨김, 로그인 요청 없이 목록 표시 — iOS가 설치 시점 Safari 쿠키를 복사 ③ 강제 종료 후 재실행에도 로그인 유지 ④ 통과(1.1–1.5초, QA-FR-SYNC-04) ⑤ 같은 세션을 공유하므로 Safari 로그아웃이 웹 앱 세션도 폐기 → 복귀 시 「세션이 종료되었습니다. 다시 로그인해 주세요.」+ 로그인 폼, 본문 노출 없음 ⑥ standalone 로그인 성공(이메일 다음 필드 이동은 입력 보조 막대 `∨`로) ⑦ `메신저 QA` 북마크 삭제 완료(운영 `메신저` 아이콘은 그대로). 참고: 로그인 폼에서 iOS 암호 앱이 운영 계정 자동 채우기를 제안함(누르지 않음) |
| 판정 | `PASS` — tailnet HTTPS 출처에서 설치·standalone·재실행 유지·S6·standalone 로그인 모두 통과. 출처는 운영 443이 아니라 같은 tailnet 호스트의 8443 테스트 출처 |
| 증거 경로 | `reports/qa/client-03/` — `add-to-home.png`, `standalone-first-launch.png`, `relaunch-after-force-quit.png`, `session-ended-after-safari-logout.png`, `standalone-login-ok.png` (gitignore, 로컬 보관) |
