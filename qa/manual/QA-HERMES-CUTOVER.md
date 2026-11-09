# QA-HERMES-CUTOVER — Slack → ohmyslack 전환 판정 기록 (ADR-001 §7 H4, DEV_DESIGN W-24, 5-4 형식)

> 기준: ADR-001 §7 H4(「§3-j 전환 기준 충족, 영환님 승인」) → **§3-j 전환 기준 6개**: 연속 7일 ① 브리핑 수신 유실 0 ② 음성 재생 성공 ③ iPhone 푸시 수신 ④ 스레드 세션 이어짐 실패 0 ⑤ 승인 왕복 1회 이상 성공 ⑥ 어댑터 fatal 0. (DEV_DESIGN W-24 행과 BRIEF는 4개 — 브리핑·유실·승인·푸시 — 만 적었지만, H4가 가리키는 정본 §3-j가 6개라 6개 모두 기록합니다.)
> 전환 판정과 Slack 끄기는 **영환님**이 합니다. 이 문서는 QA의 항목별 증거 기록입니다.
> 근거 수준: **L1** = QA 직접 실행·관찰 / **L2** = Jarvis 제공 기록. 실행하지 않은 항목은 「미검증」(DEV_DESIGN 8절 8).

## 관찰 기간

- **관찰 시작일: 2026-11-10(화) — 1일째.** 근거: 브리핑 cron 3개(`morning-ai-brief` 매일 08:00, `repo-status-brief` 평일 09:00, `brief-to-obsidian-and-proposals` 매일 09:40)의 `deliver`에 `ohmyslack` 추가 — 2026-11-09 08:59 영환님 적용, Jarvis 확인(L2). QA가 2026-11-09 09:42 `jobs.json`을 읽기 전용으로 열어 세 작업 모두 `deliver` 플랫폼이 `slack`·`ohmyslack` 두 개이고 `enabled=true`임을 확인(L1, 채널 id 미출력).
- **7일 기준 작업:** 매일 실행되는 `morning-ai-brief`(08:00). 적용(08:59)이 2026-11-09 08:00 실행 뒤라 첫 대상 실행은 2026-11-10 08:00 → **1일째 2026-11-10(화), 7일째 2026-11-16(월)**, 판정 가능일 2026-11-17(화) 이후(요일은 `date -j -f`로 확인). `repo-status-brief`는 평일만 실행되므로 7일 연속 기준에 쓰지 않고 보조 관찰로만 기록.
- **이전 기록(2026-11-09 02:40, L1):** 당시 ohmyslack 대상 `deliver` 0개, 관찰 0일째.
- **관찰 전 메모(L1, 판정 아님):** 운영 DB에서 2026-11-09 08:55 이후 봇 최상위 메시지는 09:17 1건(본문 151자)뿐이고, 09:00 `repo-status-brief`에 대응하는 시각의 최상위 봇 메시지는 없음. 게이트웨이가 09:17에 재시작됐으므로 그 전 실행의 전달 여부·원인은 미확인 — 2026-11-10 08:00 첫 관찰 대상 실행에서 Slack·ohmyslack 도착을 대조해야 함.

| 필드 | 값 |
|---|---|
| 실행자 | Claude(W-24 QA 레인, 읽기 전용 점검 — 2026-11-09 02:36–02:41; W-24b 레인 갱신 — 2026-11-09 09:40–09:45) / 실기 항목: 영환님(실기기), 기록 Jarvis(L2) |
| 일시(KST) | 2026-11-09 02:36–02:41·09:40–09:45 KST(QA 점검) / 실기 기록 2026-11-08 22:22·2026-11-09 00:28–02:33·09:20–09:26(L2) |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) macOS 27.2, Tailscale 1.104.5, Python 3.11.15 / 실기: iPhone iOS 18.7 홈 화면 PWA(L2, 운영 시험 기기 버전은 추정) |
| 접속 경로 | 운영 tailnet Serve HTTPS(`https://<host>.ts.net/` → `127.0.0.1:8787`), 봇 리스너 `127.0.0.1:8788`(루프백) |
| 절차 | ① cron `jobs.json`의 `deliver` 대상 확인(읽기 전용) ② 운영 DB 봇 메시지 일자별 최상위·답글 수, 사람 `/approve`·`/deny` 수, 오디오 첨부 수(`BEGIN READ ONLY … ROLLBACK`) ③ 각 FR 수동 증거(`QA-FR-CLIENT-05`·`QA-FR-BOT-02`·`QA-FR-BOT-04`·`QA-FR-BOT-06`·`QA-FR-OPS-05`) 판정 대조 ④ 아래 항목별 표 작성 |
| 기대 결과 | §3-j 6개 항목 모두 연속 7일 충족 증거 |
| 실제 결과 | 아래 「항목별」 표. 6개 중 **연속 7일 충족 0개** — 관찰 창은 2026-11-10 시작 예정(아직 0일 경과). 단발 증거가 있는 항목: ② 음성 재생(2026-11-09 09:21 실기 L2 + 서버측 L1, `QA-FR-OPS-05` PASS), ③ 푸시 수신(L2 실기 + L1 서버측), ⑥ 어댑터 fatal(7일 판정 불가) |
| 판정 | `미검증` — 7일 관찰 창(2026-11-10–2026-11-16)이 아직 시작 전. 전환(H4) 판정 불가 |
| 증거 경로 | (`dev/`는 gitignore — 로컬 보관) `dev/active/p1-w24-qa-cutover/evidence/db-cron-readonly.txt`(cron deliver·DB 집계), `dev/active/p1-w24-qa-cutover/evidence/client-05-push-log.txt`, `dev/active/p1-w24-qa-cutover/evidence/bot-02-serve-lsof.txt`, `dev/active/p1-w24-qa-cutover/evidence/bot-04-06-pytest.txt` · W-24b: `dev/active/p1-w24b-qa-ops05/evidence/cron-deliver-readonly.txt`·`db-attachments-readonly.txt`·`db-bot-messages-readonly.txt`·`server-log-attachments.txt` · 각 `qa/manual/QA-FR-*.md` |

## 항목별 (§3-j)

| # | 기준 | 상태 | 증거(근거 수준) | 다음 행동(누가·무엇) |
|---|---|---|---|---|
| ① | 7일 연속 브리핑 수신 유실 0 | 미검증(2026-11-10 시작 예정) | 브리핑 cron 3개 `deliver`에 `ohmyslack` 추가(2026-11-09 08:59 영환님 적용·Jarvis 확인 L2, `jobs.json` 읽기 전용 확인 L1). 기준 작업 `morning-ai-brief` 매일 08:00 — 관찰 1일째 2026-11-10, 7일째 2026-11-16. 아직 관찰 대상 실행 0회 | 영환님·Jarvis: 2026-11-10–2026-11-16 매일 `morning-ai-brief`의 Slack·ohmyslack 도착 건수 대조 기록(`repo-status-brief`는 평일 보조) |
| ② | 음성 재생 성공 | 단발 확인, 7일 미검증 | 2026-11-09 09:21:43 봇 답글 `audio/mpeg` 1,188,864 B·198,144 ms 첨부 → iPhone 재생·탐색 정상(영환님, L2). DB 첨부 행·메시지 결속·blob 1행, 서버 로그 봇 업로드 201·이후 `GET /api/attachments/:id` 206 ×3 (L1) — `QA-FR-OPS-05` `PASS`. 단 DM 요청 음성이며 브리핑 cron이 보낸 mp3는 아님 | 영환님: 관찰 기간 중 음성 브리핑 1회 이상 iPhone 재생 결과 기록(실패 시 시각을 Jarvis에 전달) |
| ③ | iPhone 푸시 수신 | 단발 확인, 7일 미검증 | 2026-11-09 02:33 운영 `b655ddd`에서 실기 수신(영환님 확인, L2), 서버 `push_send_result` 5줄 모두 `sent/201`·구독 1행 `last_success_at 02:33:36` (L1) — `QA-FR-CLIENT-05`. 2026-11-09 09:42 기준 서버 로그 `push_send_result` 9줄 모두 `sent`/201(L1, 누계 — 시각 없음) | 영환님: 관찰 기간 중 매일 1회 이상 푸시 표시 여부 기록(미표시 시각을 Jarvis에 전달) |
| ④ | 스레드 세션 이어짐 실패 0 | 미검증 | 어댑터 매핑은 pytest PASS(L1, `QA-FR-BOT-04`). Hermes 런타임 세션 연속성, 특히 브리핑 답글은 README 「Hermes 확인 항목」 4에서 「런타임은 미확인」(`cron.mirror_delivery` 기본 꺼짐이면 브리핑 답글은 새 세션일 가능성 큼) | 영환님: DM 스레드에서 2턴 이상 대화해 앞 턴 내용을 기억하는지 확인. 브리핑 답글 연속성이 필요하면 `cron.mirror_delivery` opt-in 결정 |
| ⑤ | 승인 왕복 1회 이상 성공 | 미검증 | 어댑터 owner 외 `/approve` 무시 pytest PASS(L1), 운영 사람 `/approve`·`/deny` 메시지 0건(L1) — `QA-FR-BOT-06` | 영환님: `QA-FR-BOT-06` 절차 ④ 1회 실행 |
| ⑥ | 어댑터 fatal 0(7일) | 미검증(미시작) | 2026-11-08 22:22 Jarvis DM 왕복 성공, 이후 답글 계속 게시(봇 답글 11-09 7건, L1) — 연결 유지의 간접 증거일 뿐 7일 fatal 로그 점검은 안 함 | Jarvis: 관찰 기간 동안 매일 게이트웨이 로그의 ohmyslack `fatal`(`unauthorized`·`config_invalid`) 0 확인(읽기 전용) |
