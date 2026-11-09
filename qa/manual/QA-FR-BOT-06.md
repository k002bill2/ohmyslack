# QA-FR-BOT-06 — owner 외 `/approve` 무시 + 실기 승인 왕복 (DEV_DESIGN 6-2 FR-BOT-06, 5-4 형식)

> 기준: DEV_DESIGN 6-2 FR-BOT-06 「수동」 열(`어댑터 pytest: owner 외 작성자 /approve 무시 + 실기 승인 왕복 1회`) — **두 조건 모두** 필요. ADR-001 D-5(승인 텍스트 명령), §3-j 전환 기준 ⑤.
> 근거 수준: pytest 부분은 **L1**(QA 직접 실행). 실기 승인 왕복은 사람(영환님)이 해야 하며 **실행 기록 없음**.
> 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).

| 필드 | 값 |
|---|---|
| 실행자 | pytest: Claude(W-24 QA 레인) / 실기 승인 왕복: Aside(영환님 계정 `kangyounghwan`(owner)으로 서버 Mac Chrome에서 운영 Jarvis DM 조작) |
| 일시(KST) | pytest 2026-11-09 02:36·02:40 KST / 운영 DB 확인 2026-11-09 02:40 KST / 실기 왕복 2026-11-09 21:43–21:46 KST(10:02–11:22 KST 시도 3회는 승인 요청 미발생) |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) / macOS 27.2 / Python 3.11.15 로컬 `.venv` / 실기 왕복용 기기: 미정(iPhone PWA 또는 데스크톱 브라우저) |
| 접속 경로 | pytest: localhost 가짜 aiohttp 봇 서버(운영 미접속) / 실기 왕복(예정): tailnet Serve HTTPS 운영 Jarvis DM |
| 절차 | ① `QA-FR-BOT-04.md` 절차 ①–④와 같은 pytest 전체 실행 ② 지정 테스트 `tests/test_inbound.py::test_approve_text_passes_through_and_non_owner_approve_ignored`·`test_filters_self_echo_non_owner_and_duplicates` 단독 실행 ③ 운영 DB에서 사람이 보낸 `/approve`·`/deny` 메시지 수를 `BEGIN READ ONLY … ROLLBACK`로 셈(본문 비출력) ④ **(사람, 미실행)** 영환님이 Jarvis DM에서 승인이 필요한 작업을 요청(예: 확인 프롬프트가 뜨는 명령 실행 지시) → Jarvis가 승인 요청 게시(명령 문구는 인라인 코드) → 영환님이 같은 스레드에 `/approve` 입력 → Jarvis가 작업 수행 결과를 같은 스레드에 게시. 같은 방식으로 `/deny` 1회(선택) |
| 기대 결과 | pytest: owner가 아닌 작성자의 `/approve`는 Hermes로 넘어가지 않고, owner의 `/approve`·`/deny`는 원문 그대로 넘어감. 실기: 승인 요청 → owner `/approve` → 작업 수행·결과 게시가 같은 스레드에서 1회 이상 완료 |
| 실제 결과 | ①② pytest 전체 `52 passed, 1 deselected` EXIT 0, 지정 테스트 `PASSED`(비owner `/approve` 1건 무시, owner `/approve`·`/deny` 2건만 이벤트, `user_id == OWNER_ID`) — **L1, 통과** ③ 운영 DB 사람 작성 `/approve`·`/deny` 메시지 **0건**(L1) → 실기 승인 왕복이 아직 한 번도 일어나지 않았다는 증거 ④ **미실행** |
| 판정 | `PASS` — pytest(①②, L1) + 실기 승인 왕복 1회(④, L1) 모두 충족. `/deny` 1회(선택)도 통과. 단 승인 요청을 띄우기 위해 Hermes `approvals.mode`를 시험 동안만 `manual`로 바꿈(운영 기본 `smart`에서는 /tmp 한정 무해 명령이 자동 승인되어 사람 승인 경로가 거의 쓰이지 않음 — 아래 「실기 왕복 기록」 참고) |
| 증거 경로 | (`dev/`는 gitignore — 로컬 보관) `dev/active/p1-w24-qa-cutover/evidence/bot-04-06-pytest.txt`(pytest), `dev/active/p1-w24-qa-cutover/evidence/db-cron-readonly.txt`(`human_approve_or_deny_msgs = 0`) · 테스트 소스 `integrations/hermes-plugin/tests/test_inbound.py:172-181` · 자동 증거: `apps/web/test/conversation/slash-text.test.tsx`(지정) · 실기 왕복 증거: `reports/qa/BOT-06/bot06-request.png`(승인 요청)·`bot06-approve-result.png`·`bot06-deny-result.png`(gitignore), 운영 Jarvis DM 「[BOT-06 승인 왕복 시험]」 스레드 |

## 실기 왕복 기록 (④, 2026-11-09)

| 시각(KST) | 내용 | 결과 |
|---|---|---|
| 10:02 | `mkdir -p /tmp/ohmyslack-bot06-qa && rm -rf …` 요청 | 승인 요청 없음 — 저장된 `always` 항목(`delete in root path`·`recursive delete`)으로 자동 승인 |
| 10:05 | allowlist에 없는 `chmod 777`·`find -delete`(/tmp 한정) | 승인 요청 없음 — `approvals.mode: smart`가 무해 판단해 자동 승인 |
| 11:22 | 「다시」(mode 변경 보고) | 승인 요청 없음 — 파일은 여전히 `smart`(저장 안 됨) |
| 21:43 | Aside가 터미널에서 `~/.hermes/profiles/jarvis/config.yaml` 427행 `mode: smart`→`manual`(백업 후 `sed`, diff로 1줄만 바뀜 확인). `cron_mode: deny`는 그대로 | — |
| 21:43 | 같은 스레드에 `chmod 777 /tmp/ohmyslack-bot06-qa/probe.txt` 재요청 | Jarvis가 같은 스레드에 「⚠️ Hermes wants to run a command that needs your OK」 게시, 명령은 인라인 코드(`<code>`), 사유 `world/other-writable permissions` |
| 21:43 | owner가 같은 스레드에 `/approve`(1회, always 아님) | 「✅ Command approved」 → exit 0, 권한 `-rw-r--r--`→`-rwxrwxrwx`, 결과를 같은 스레드에 게시(21:44) |
| 21:44 | (선택) `probe2.txt`에 `chmod 777` → 승인 요청 → owner `/deny` | 「❌ Command denied」, exit -1 `blocked`, 권한 `-rw-r--r--` 그대로, 우회 재시도 없음 |
| 21:46 | 427행 `manual`→`smart` 복원 | `cmp`로 시험 전 파일과 바이트 동일 확인(allowlist 신규 항목 없음). /tmp 시험 파일·폴더 삭제됨 |

**관찰(판정 외):** 운영 기본 `smart` 모드와 저장된 `always` 항목 때문에, 실제 운영에서는 사람 승인 요청이 드물게 뛸 수 있음. `manual` 모드에서도 `always` 항목은 그대로 자동 승인됨(정리용 `rm`이 `delete in root path`로 통과). Jarvis가 10:04에 만든 백업 `config.yaml.bak-20261109-bot06`은 남아 있음(시험 전 상태와 같은 크기).
