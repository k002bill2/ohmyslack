# QA-FR-CLIENT-01 — 데스크톱 두 구간 키보드 조작 (DEV_DESIGN 6-2 FR-CLIENT-01, 5-4 형식)

> 기준: PRD FR-CLIENT-01 수용 기준 + 디자인 §7-3 키맵(정본) + §11-4 QA 체크리스트("§7-3 전 항목 수행"). §7-3 주석: `⌃⌥` 조합이 브라우저·OS 기본 동작과 겹치지 않는지 **macOS Safari·Chrome**으로 확인.
> 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).

| 필드 | 값 |
|---|---|
| 실행자 | Claude(W-16 QA 레인, ego-browser 자동 조작) — macOS Safari 부분 미실행 |
| 일시(KST) | 1차 2026-11-08 12:08–12:10 KST(FAIL, F-1) / 재검증 2026-11-08 14:20–14:21 KST(F-1 구현 후, 브랜치 `feat/w16-keymap-focus` 빌드) |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) / macOS 27.2 / ego-browser 0.6.2.9 (Chromium 156.0). macOS Safari 미실행 |
| 접속 경로 | localhost(`http://127.0.0.1:<임의 포트>`, 테스트 DB 실행별 스키마) |
| 절차 | 뷰포트 wide 1280×800·medium 800×800(CDP)마다: ① 페이지 로드 직후(포커스 body) `⌘K` → 전환기 → `kb-al` 입력 → `Enter` ② 작성기에서 `Ctrl+K` → `↓` → `Enter` ③ `⌃⌥↑` ④ 작성기 입력 + `Enter` ⑤ `Shift+Tab`으로 메시지 목록 정류장 ⑥ 목록에서 `↑`·`Home`·`End` ⑦ `R` → 스레드 → 빈 작성기 `Esc` ⑧ 메시지에서 `E` → `Esc` ⑨ `Delete` → `Esc` ⑩ `Backspace` → `Esc` ⑪ `⌘/` → `Esc`. 별도로 wide 입력 있는 스레드 `Esc` 1회·2회(1차 실행 로그) |
| 기대 결과 | PRD: wide·medium 각각 키보드만으로 공간 전환·전송·스레드 닫기, 포커스가 원래 항목으로 복귀. §7-3 전 항목: 전환기(기본 전환 수단)·`⌃⌥↑/↓`→작성기·`Enter` 전송→작성기 유지·스레드 `Esc`→원문 `답글`·입력 있음 `Esc` 2회 규칙·메시지 `R`/`E`/`Delete`·`⌘/` 안내·메시지 단위 roving tabindex |
| 실제 결과 | **Chromium, 두 구간 모두 기대대로(재검증):** ① 전환기 열림(입력 포커스) → `#kb-alpha` 이동·포커스 작성기 ② 두 번째 후보로 이동·작성기 ③ 이전 공간·작성기 ④ 전송 후 작성기 유지 ⑤ 활성 메시지의 `삭제`→`수정`→메시지 항목(목록은 정류장 하나, 활성=마지막 메시지) ⑥ 이전·첫·마지막 메시지로 이동 ⑦ 스레드 답글 작성기 → 닫힘·포커스 원문 `답글` ⑧ 인라인 편집기 → 취소 후 메시지 항목 ⑨⑩ `메시지 삭제` 확인 Dialog → 취소 후 메시지 항목 ⑪ `키보드 단축키` Dialog → 닫힌 뒤 메시지 항목. 1차 로그: wide 입력 있음 `Esc` 1회 안내 "닫으려면 Esc를 한 번 더 누르세요"·2회 닫힘·초안 보존, medium 오버레이 `Esc` 1회 닫힘. `⌃⌥`·`⌘K`·`⌘/`가 Chromium 기본 동작을 가로채지 않음. **미실행:** macOS Safari에서 같은 키 조합의 충돌 여부(§7-3 주석) |
| 판정 | `미검증` — Chromium에서는 §7-3 전 항목과 PRD 수용 기준 통과(1차 FAIL 원인 F-1 해소). §7-3이 요구하는 macOS Safari 확인이 남아 PASS로 적지 않음 |
| 증거 경로 | 재검증 `reports/qa/client-01-r3/keyboard-r2.json`(단계별 포커스·대화상자·스레드 상태), `reports/qa/client-01-r3/{wide,medium}-{after-switch,thread,delete-dialog,shortcuts}.png` · 1차 `reports/qa/client-01/{keyboard,thread-keyboard}.json` — `reports/`는 gitignore(로컬 보관). 자동 증거: `apps/web/test/layout/keyboard.test.tsx`(지정)·`keyboard-switcher.test.tsx`·`apps/web/test/conversation/message-keys.test.tsx` |
