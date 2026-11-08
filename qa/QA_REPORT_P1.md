# W-16 QA 독립 검증 보고서 — 단계 P1 (진행 중)

> 갱신 2026-11-08 14:25 KST: 발견 F-1·F-2·F-4를 브랜치 `feat/w16-keymap-focus`(미커밋)에서 수정·검증했다 — 7절.

> 정본: DEV_DESIGN §4 W-16, §5-1(판정 모드), §5-4(수동 증거 형식), §6-2(FR 매핑).
> 실행하지 않은 항목은 "미검증"으로 둡니다(DEV_DESIGN 8절 8). 근거 수준: L1 = 이번에 직접 실행·관찰.

## 1. 요약

| 항목 | 결과 |
|---|---|
| 대상 커밋 | `74b822e` (main, 깨끗한 detached worktree) |
| `pnpm verify` | **PASS** — exit 0, `=== VERIFY PASSED` |
| `check:fr-coverage --mode=gate` | **FAIL** — exit 1, `실패:` 17줄 + 미구현 집계 1(FR-OPS-02) = 18건(아래 3절). 수동·실기·측정 증거 미완, 발견 F-1(키맵)·F-4(작성기 포커스 링) |
| 수동 QA 14건 | PASS 7(BOOT-01·CLIENT-01·03·07·OPS-04·SYNC-01·04) · FAIL 0 · 미검증 5(CLIENT-02·04·OPS-01·02·SYNC-07) · 미실행 2(MSG-08·OPS-03) — 9절 실기 QA 반영 후 |
| G1 신청 가능 여부 | **아직 불가** — 3절 "남은 일" 완료 후 판정 모드 재실행 필요 |
| 교차 검증 | Codex 1라운드: P1 2·P2 2 지적(CLIENT-07 과대 PASS 2건, 전송 중 그레이스케일 증거, 소수 폭 대체 증거) — 전부 반영. F-1·F-2·F-3 코드 주장은 Codex가 소스로 재확인 |

## 2. 자동 게이트 (L1, 2026-11-08 KST, Node v26.13.0 · pnpm 10.30.2 · PostgreSQL 15.15 · macOS 27.2 arm64)

| 명령 | 결과 |
|---|---|
| `pnpm install --frozen-lockfile` | 통과. **주의:** 깨끗한 체크아웃에서 `pnpm verify`를 바로 실행하면 `tsx: command not found`로 실패한다(verify 자체가 `tsx`로 실행되는데 install은 그 안의 단계). install을 먼저 해야 한다 — 문서 보강 후보 |
| `pnpm verify` | 단위 941/941(shared 5·server 298·tools 144·web 494), 통합 113/113(38파일), 커버리지 lines server 87.85%·web 98.04%·tools 98.2%·shared 90%(임계 80%), build·check 5종·audit 통과 |
| `check:fr-coverage --mode=gate` | P0 FR 33개 중 구현 32 / 미구현 1(FR-OPS-02 — 드릴 `.sh` + 수동 QA PASS로 판정하는 설계라 승인 전에는 미구현으로 집계). TR-SEC 지정 3개 미구현 0 |

## 3. 판정 모드 실패 18건과 상태

| # | 실패 | 현재 상태 | 닫는 방법 | 담당 |
|---|---|---|---|---|
| 1 | ~~QA-FR-CLIENT-01~~ **닫힘** | 9절: macOS Safari 27.2 wide·medium 통과, 기본 단축키 충돌 없음 → PASS | — | — |
| 1b | QA-FR-CLIENT-07 판정 FAIL | 작성기 포커스 링 정본 위반(F-4) | 2px 링 + 2px 오프셋 구현 후 재검증(멘션 후보 선택 포함, 두 번째 사용자 필요) | Developer → QA |
| 2 | QA-FR-CLIENT-02 미검증 | 데스크톱 22조합·compact 이동 통과, iPhone S2 전송·S4·S6 통과(9절) | ① 640.5·1023.5px 실제 렌더 ② iPhone 길게 누르기 수정·삭제 ③ 가상 키보드 가림(F-6 연관) | ① QA ② ③ 영환님(실기, 실제 손가락) |
| 3 | ~~QA-FR-CLIENT-03~~ **닫힘** | 9절: 홈 화면 추가·standalone 로그인·강제 종료 후 재실행 세션 유지·S6 → PASS | — | — |
| 4 | QA-FR-CLIENT-04 미검증 | macOS Safari·iOS Safari·웹 앱에서 로그아웃 후 뒤로·앞으로·복원·재실행 본문 재노출 없음(9절) | iPhone 실기 저장소 검사(Web Inspector) | 영환님(실기) |
| 5 | QA-FR-MSG-08 파일 없음 | 미실행 — iPhone 미러링은 Mac 키보드 입력이라 iOS 소프트 키보드 한글 조합 재현 불가(9절) | 디자인 §7-4 7항목 × iOS Safari·웹 앱(실제 소프트 키보드), macOS Safari·Chrome | 영환님(실기 IME) |
| 6 | ~~QA-FR-SYNC-04~~ **닫힘** | 9절: Mac 읽음 → iPhone 웹 앱 본문 1.1s·스레드/멘션 1.5s, iOS Safari 1.35s(≤ 2s), 스레드 unread 본문 수 미합산 → PASS | — | — |
| 7 | QA-FR-SYNC-07 미검증 | 9절: 5분 3초 백그라운드 복귀 후 105건·수정·삭제·타 기기 읽음 반영 정확. 「최신 상태 확인 중…」 미표시, 「다시 연결 중…」 약 2.9s(F-5) | F-5 수정 후 재실행 + 서버 꺼진 상태 복귀 경로 | Developer → 영환님(실기) |
| 8–9 | ~~FR-SYNC-01 지정 테스트 결과 없음 + QA 미검증~~ **닫힘** | 8절: (a) p95 40.8ms·오류 0, (b) p95 128ms → QA-FR-SYNC-01 PASS | — | — |
| 10 | QA-FR-OPS-01 미검증 | 미실행 | 점검 명령 8개 **[조회·승인 필요]** | 영환님 승인 → QA |
| 11 | QA-FR-OPS-02 미검증 | 자동 드릴 `DRILL OK 7/7` 기록됨 | 승인자 확인 칸 서명 | 영환님 |
| 12 | QA-FR-OPS-03 파일 없음 | 미실행 | Tailscale Serve 쪽 로그 점검(조회 승인 필요) | 영환님 승인 → QA |
| 13–16 | TR-SEC-07·08·09·10 참조 FR 미충족 | 각각 OPS-01·CLIENT-04·OPS-03·OPS-02에 종속 | 위 2·4·10·11·12가 닫히면 함께 닫힘 | — |
| 17 | FR-OPS-02 미구현 집계 | 위 11과 같음 | 승인 서명 | 영환님 |

## 4. 이번에 실행한 수동 QA (L1)

| 문서 | 판정 | 핵심 근거 |
|---|---|---|
| `qa/manual/QA-BOOT-01.md` | **PASS** | 합성 스키마 리허설: 첫 실행 exit 0 → 다른 이메일 재실행 exit 1 `owner_exists`·행 수 1,1,1 불변 → 출력·`pg_dump` 덤프에 합성 비밀번호 0건. 원격 라우트 없음·초대/수락은 `bootstrap.int.test.ts` 5/5 |
| `qa/manual/QA-FR-CLIENT-07.md` | **FAIL** | 작성기 포커스 표시가 1px 테두리 색 변화뿐 — 정본 §7-1 "2px 링 + 2px 오프셋" 위반(F-4). 그 밖에는 통과: 8개 화면 상태 이름 없음 0, 200% 동등에서 SCR-04 조작(만들기·전송·수정·삭제·답글·나가기) 가능(멘션 선택은 미실행), 4상태 그레이스케일 텍스트 구분, 스레드 닫기 후 `답글` 포커스 복귀 |
| `qa/manual/QA-FR-OPS-04.md` | **PASS** | 허용 경로 밖 에셋 0·오디오 0, manifest 이름 중립, 심볼 독자 제작 표기, 폰트 sha256 일치·OFL 동봉, 토큰 source/license 7/7 |
| `qa/manual/QA-FR-CLIENT-01.md` | **FAIL** | PRD 문장(공간 전환·전송·스레드 닫기·포커스 복귀)은 wide·medium 모두 충족. §11-4 "§7-3 전 항목"에서 F-1 |
| `qa/manual/QA-FR-CLIENT-02.md` | 미검증 | 데스크톱 11폭 × 스레드 닫힘/열림 22조합 전부 정본대로(넘침 0, 단수, 1024–1119 사이드바 72px 접힘, 1120 복귀), compact 공간→본문→스레드→뒤로. iPhone 남음 |
| `qa/manual/QA-FR-CLIENT-04.md` | 미검증 | 저장소엔 숫자 checkpoint 1개뿐(로그아웃 시 삭제), Cache Storage 셸만·`/api/` 0, 로그아웃 후 back·forward·bfcache 복원·reload 6경로 본문 재노출 0. Safari·iOS 남음 |

브라우저: ego-browser 0.6.2.9 (Chromium 156.0), 뷰포트는 CDP `Emulation.setDeviceMetricsOverride`. 버튼 조작은 포커스 + `Enter`(ego가 포인터 동작 전에 탭 가시성을 토글해 레이아웃이 움직이는 하네스 특성 — `.claude/skills/verify-ohmyslack/SKILL.md` Exceptions 1).

## 5. 발견

| ID | 심각도(QA 판단) | 내용 | 근거 | 제안 |
|---|---|---|---|---|
| F-1 | 중 — G1 차단 | 디자인 §7-3 키맵 중 `⌘/Ctrl+K` 공간 전환기(정본상 "기본 전환 수단"), 메시지 `R`/`E`/`Delete`, `⌘/Ctrl+/` 단축키 안내, 메시지 단위 roving tabindex가 구현되지 않음 | 실기 키 입력 무반응 + 소스: 키 처리기는 `AppShell.tsx:311`(`⌃⌥↑/↓`), `ime.ts`, `ThreadPanel.tsx:101`, `Dialog.tsx:53`뿐 | 영환님 결정: (a) 구현(W-10 계열 후속) 또는 (b) §7-3을 MVP 범위로 축소하는 정본 개정. 결정 전까지 QA-FR-CLIENT-01 FAIL 유지 |
| F-2 | 중 — G1 차단 | FR-SYNC-01 (b) 표시 지연 측정 절차를 그대로 실행할 수 없음: `perf/latency.perf.ts` 서버(`testApp`)가 웹 측정 빌드(`dist-measure`)를 서빙하지 않아 관측 브라우저가 같은 출처에서 열 화면이 없음 | `perf/latency.perf.ts`·`e2e/support/harness.ts`에 정적 서빙 옵션 없음 | 하네스에 `dist-measure` 정적 서빙(예: env로 `webDistDir` 주입) 추가 후 QA가 측정 |
| F-3 | 낮음 | 전송 응답(HTTP)이 WS `message.created`보다 늦으면 같은 메시지가 **확정본 + "전송 중" 2개**로 HTTP 응답 때까지 보임(지연 3초 재현: 200·1000·2500ms 2개 → 5000ms 1개). DB는 1행 | `reports/qa/finding-dup/samples.json`·`dup-1000ms.png`, `apps/web/src/features/conversation/send-status.ts:66` 주석 "전송 중에는 표식만 남기고 HTTP 응답을 기다린다(Q-3 결정 전 기본값)" | Q-3 결정 시 `serverEventSeen` 항목을 목록에서 숨기거나 확정본과 합치기 |
| F-4 | 중 — G1 차단 | 작성기 포커스 표시가 감싼 테두리 1px 색 변화(회색→청록)뿐 — 정본 §7-1 "2px 링 + 2px 오프셋" 위반 | 계산 스타일 `QA-FR-CLIENT-07.md` ④, `apps/web/src/features/conversation/conversation.css:378` | `.composer:focus-within`에 2px 링 + 2px 오프셋(다른 컨트롤과 같은 토큰) 후 CLIENT-07 재검증 |
| F-5 | 정보 | 깨끗한 체크아웃에서 `pnpm verify` 단독 실행 불가(`tsx` 없음) | 2절 | CLAUDE.md/DEV_DESIGN 5-1에 "install 먼저" 한 줄 |

## 6. 증거 보관

- 명령 출력·스크린샷·JSON: `reports/qa/<항목>/`, `reports/verify-app/`(gitignore — 이 맥에만 있음). 각 QA 문서의 "실제 결과" 칸에 요약을 옮겨 두었다.
- 깨끗한 체크아웃 로그: 세션 스크래치패드 `w16-verify.log`, `w16-gate2.log`(저장소 밖).

## 7. 발견 수정 (브랜치 `feat/w16-keymap-focus`, 미커밋)

| ID | 처리 | 검증 |
|---|---|---|
| F-1 | 구현: `Ctrl/⌘+K` 공간 전환기(APG combobox, 문구 G-33), `Ctrl/⌘+/` 단축키 안내(D §7-3 행 그대로), 메시지 `R`/`E`/`Delete`, 메시지 목록 roving tabindex. **가정(정본 공백, QA 판단으로 기록):** 목록 안 이동 `↑/↓`·`Home/End`(Q-10), 맥 키보드용 `Backspace`도 삭제, `R`/`E`는 물리 키(`code`) 기준(한글 자판 상태에서도 동작), Tab은 활성 메시지 안의 버튼까지만, compact는 기존 버튼 유지 | 단위·컴포넌트 테스트 신규 20건, 지정 테스트 `keyboard.test.tsx` 무수정 통과. 실브라우저(Chromium) wide·medium 전 항목 통과 → QA-FR-CLIENT-01은 **macOS Safari 확인만 남아 미검증** |
| F-2 | 하네스 관측 모드: `PERF_OBSERVER_WAIT_S>0`이면 `apps/web/dist-measure`를 같은 출처로 서빙하고 허용 출처를 실제 리슨 주소로, 하네스의 HTTP·로그인·WS도 그 출처로(기본 경로 동작 동일). `dist-measure` 없으면 즉시 실패 + 빌드 명령 안내. QA-FR-SYNC-01 절차 2–3·전제 갱신 | 신규 `e2e/observer-origin.e2e.test.ts` 2건, 기본 모드 `perf:latency:smoke` 통과, 관측 모드 smoke에서 셸 200·로그인 200. **(b) 실측은 아직 안 함** — 10분 부하 + 관측 브라우저 필요 |
| F-4 | `.composer:has(.composer-input:focus-visible)`에 `outline: 2px solid var(--focus-ring); outline-offset: 2px` | CSS 계약 테스트, 실브라우저 계산 스타일 `solid 2px`·`offset 2px` → QA-FR-CLIENT-07 **PASS** |
| F-3 | 범위 밖(Q-3 결정 대기) | — |

- 게이트: 브랜치에서 `pnpm verify` exit 0(단위 shared 5·server 298·tools 144·web 515, 통합 39파일 115건).
- 교차 검증: Codex F-1/F-4 3라운드(r1 P2 5 → r2 P2 1 → r3 0), F-2 1라운드(P2 1, 반영). 전부 반영.

## 8. FR-SYNC-01 측정 (2026-11-08 KST, 커밋 f17566b)

- 1차 15:39–15:54: **무효.** 관측 탭이 ego-browser 백그라운드 태스크 스페이스라 rAF가 1–2회/s로 제한됨(`visibilityState`는 visible). CDP `Page.bringToFront`·포커스 에뮬레이션으로 해소 안 됨 → 사람이 ego-browser 창을 앞에 띄워야 함. `raf` p95 686ms는 판정에서 제외.
- 2차 15:55–16:11: 영환님이 창을 전경에 둠(부하 전 rAF 62회/s). (a) 3000건·오류 0·전달 57000/57000·p95 40.8ms, (b) `raf` p95 128ms·p99 155ms·max 358ms·표본 3000. 부하 중 전경 유지 근거는 표본 전체의 `raf-commit` p95 1ms·max 53ms(제한 상태면 수백 ms). → QA-FR-SYNC-01 **PASS**.
- 게이트 재실행: `check:fr-coverage --mode=gate` 실패 줄 16 → 14(SYNC-01 2줄 해소), 여전히 exit 1(실기·승인 항목).

## 9. 실기 QA (2026-11-08 17:26 이후 KST, 빌드 `69d1078`, 테스트 DB 서버를 tailnet Serve 8443으로 노출 — 운영 서버·DB 미사용)

실행: 별도 세션. macOS Safari 27.2(키 이벤트 전달), iPhone은 iPhone 미러링으로 조작. 결과 PASS 3(CLIENT-01·SYNC-04·CLIENT-03) · 미검증 3(SYNC-07·CLIENT-04·CLIENT-02) · 미실행 1(MSG-08, 파일 없음). 증거 `reports/qa/<항목>/`(gitignore, 로컬). 정리: 테스트 스키마·임시 하네스·iPhone 「메신저 QA」 아이콘 삭제, Safari 창 크기 원복. **남은 사람 조치:** Serve 8443 끄기(`tailscale serve --https=8443 off`, 테스트 서버는 이미 종료 → 502).

| ID | 심각도 | 내용 | 근거 수준 | 제안 |
|---|---|---|---|---|
| F-5 | 중 — SYNC-07 차단 | 복귀 시 `resume()`이 `catching-up`으로 바꾼 뒤 늦게 온 WS 종료가 `onClose`에서 무조건 `reconnecting`으로 덮어씀(`apps/web/src/data/http-source.ts:497` vs `:752`). 배지·구분선 보류가 `connection === 'catching-up'`에만 걸려 있어(`apps/web/src/features/layout/AppShell.tsx:463,468`) catch-up 도중 보류가 풀릴 수 있음 | L1 실기 화면(「확인 중」 미표시·「다시 연결 중」 2.9s) + L2 코드 확인. 배지 깜빡임 자체는 미관측 | `resuming` 중에는 `onClose`가 `catching-up`을 덮지 않게(또는 resume 완료 시 재판정) + 회귀 테스트 |
| F-6 | 하 | iOS에서 작성기 포커스 시 「자동 완성 연락처」 막대가 작성기·전송 버튼을 가림. textarea에 `autocomplete` 지정 없음 | L1 실기 | `autocomplete="off"` 등 지정 후 iPhone 재확인(CLIENT-02 가상 키보드 항목과 함께) |
| F-7 | 확인 필요 | compact 「메시지 작업」 버튼을 미러링으로 탭하면 시트가 안 열리고 목록만 약 70px 이동, 펼친 버튼이 작성기 뒤에 가려지기도 함 | L1(미러링 입력 — 실제 터치와 다를 수 있음) | 실제 손가락으로 재현 여부 확인 후 판단 |

- 게이트 재실행(main `c960e9d` 위, 2026-11-08): P1 범위에서 CLIENT-01·CLIENT-03·SYNC-04 실패 줄 해소. 남은 P1 실패는 MSG-08(파일 없음)·SYNC-07·CLIENT-02·CLIENT-04·OPS-01·OPS-02(판정 미PASS)·OPS-03(파일 없음)과 TR-SEC-07~10 종속. main에 병합된 후속 레인(W-18 봇·W-20 등)의 FR-MSG-10·CLIENT-05·OPS-05·BOT-01~06·TR-SEC-13~15 줄도 함께 나오며, 이는 P1 범위 밖(일부는 이 작업 트리에서 테스트 결과 파일이 없어 "실행 결과 없음"으로 집계 — `pnpm verify` 후 재판정 필요).
