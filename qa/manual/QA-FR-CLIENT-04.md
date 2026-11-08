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
