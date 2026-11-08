# QA-HERMES-CUTOVER — Slack → ohmyslack 전환 판정 기록 (ADR-001 §7 H4, DEV_DESIGN W-24, 5-4 형식)

> 기준: ADR-001 §7 H4(「§3-j 전환 기준 충족, 영환님 승인」) → **§3-j 전환 기준 6개**: 연속 7일 ① 브리핑 수신 유실 0 ② 음성 재생 성공 ③ iPhone 푸시 수신 ④ 스레드 세션 이어짐 실패 0 ⑤ 승인 왕복 1회 이상 성공 ⑥ 어댑터 fatal 0. (DEV_DESIGN W-24 행과 BRIEF는 4개 — 브리핑·유실·승인·푸시 — 만 적었지만, H4가 가리키는 정본 §3-j가 6개라 6개 모두 기록합니다.)
> 전환 판정과 Slack 끄기는 **영환님**이 합니다. 이 문서는 QA의 항목별 증거 기록입니다.
> 근거 수준: **L1** = QA 직접 실행·관찰 / **L2** = Jarvis 제공 기록. 실행하지 않은 항목은 「미검증」(DEV_DESIGN 8절 8).

## 관찰 기간

- **관찰 시작일: 아직 시작하지 않음(0일째).** 근거(L1, 2026-11-09 02:40 KST): Jarvis 프로필 cron `jobs.json` 14개 작업 중 `deliver`에 `ohmyslack`이 들어간 작업 **0개**. 브리핑 작업 3개(`morning-ai-brief` 매일 08:00, `repo-status-brief` 평일 09:00, `brief-to-obsidian-and-proposals` 매일 09:40)는 모두 `slack:` 대상만. 운영 DB 봇 최상위 메시지(브리핑 형태) 0건 — 봇 메시지는 답글뿐(11-08 1건, 11-09 7건).
- **남은 기간: 7일 전부.** 예: 영환님이 2026-11-09 08:00 이전에 브리핑 `deliver`를 `slack:…,ohmyslack`으로 바꾸면 관찰 창은 2026-11-09(월)–2026-11-15(일), 판정 가능일 2026-11-16(월)(날짜는 `date -j -v+Nd`로 계산). 단 ②가 개발 작업으로 막혀 있어(아래), 그 전에 시작한 7일 창은 ②를 충족할 수 없습니다.

| 필드 | 값 |
|---|---|
| 실행자 | Claude(W-24 QA 레인, 읽기 전용 점검) / 실기 항목: 영환님(실기기), 기록 Jarvis(L2) |
| 일시(KST) | 2026-11-09 02:36–02:41 KST(QA 점검) / 실기 기록 2026-11-08 22:22·2026-11-09 00:28–02:33(L2) |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) macOS 27.2, Tailscale 1.104.5, Python 3.11.15 / 실기: iPhone iOS 18.7 홈 화면 PWA(L2, 운영 시험 기기 버전은 추정) |
| 접속 경로 | 운영 tailnet Serve HTTPS(`https://<host>.ts.net/` → `127.0.0.1:8787`), 봇 리스너 `127.0.0.1:8788`(루프백) |
| 절차 | ① cron `jobs.json`의 `deliver` 대상 확인(읽기 전용) ② 운영 DB 봇 메시지 일자별 최상위·답글 수, 사람 `/approve`·`/deny` 수, 오디오 첨부 수(`BEGIN READ ONLY … ROLLBACK`) ③ 각 FR 수동 증거(`QA-FR-CLIENT-05`·`QA-FR-BOT-02`·`QA-FR-BOT-04`·`QA-FR-BOT-06`·`QA-FR-OPS-05`) 판정 대조 ④ 아래 항목별 표 작성 |
| 기대 결과 | §3-j 6개 항목 모두 연속 7일 충족 증거 |
| 실제 결과 | 아래 「항목별」 표. 6개 중 **연속 7일 충족 0개** — 관찰 창이 시작되지 않음. 단발 증거가 있는 항목: ③ 푸시 수신(L2 실기 + L1 서버측), ⑥ 어댑터 fatal(관찰 시작 전이라 7일 판정 불가). ② 음성은 어댑터 미구현으로 시험 불가 |
| 판정 | `미검증` — 7일 관찰 미시작(브리핑이 ohmyslack에 전달되지 않음). 전환(H4) 판정 불가 |
| 증거 경로 | (`dev/`는 gitignore — 로컬 보관) `dev/active/p1-w24-qa-cutover/evidence/db-cron-readonly.txt`(cron deliver·DB 집계), `dev/active/p1-w24-qa-cutover/evidence/client-05-push-log.txt`, `dev/active/p1-w24-qa-cutover/evidence/bot-02-serve-lsof.txt`, `dev/active/p1-w24-qa-cutover/evidence/bot-04-06-pytest.txt` · 각 `qa/manual/QA-FR-*.md` |

## 항목별 (§3-j)

| # | 기준 | 상태 | 증거(근거 수준) | 다음 행동(누가·무엇) |
|---|---|---|---|---|
| ① | 7일 연속 브리핑 수신 유실 0 | 미검증(미시작) | cron 브리핑 3개 모두 `deliver: slack:` 뿐, ohmyslack 대상 0개. 봇 최상위 메시지 0건 (L1) | 영환님: 브리핑 3개 작업의 `deliver`에 `ohmyslack` 추가(README 「Hermes 확인 항목」 3: 콤마 다중 대상 지원 확인됨) → 매일 Slack·ohmyslack 도착 건수 대조 |
| ② | 음성 재생 성공 | 미검증(차단: 개발) | 어댑터 `send_voice` 텍스트 대체(`adapter.py:420-421`), 운영 오디오 첨부 0건 (L1) — `QA-FR-OPS-05` | Jarvis: W-20 첨부 확장(어댑터 `send_voice`→봇 업로드 라우트) 레인 발주 → 영환님: 배포·재시작 → iPhone 재생 |
| ③ | iPhone 푸시 수신 | 단발 확인, 7일 미검증 | 2026-11-09 02:33 운영 `b655ddd`에서 실기 수신(영환님 확인, L2), 서버 `push_send_result` 5줄 모두 `sent/201`·구독 1행 `last_success_at 02:33:36` (L1) — `QA-FR-CLIENT-05` | 영환님: 관찰 기간 중 매일 1회 이상 푸시 표시 여부 기록(미표시 시각을 Jarvis에 전달) |
| ④ | 스레드 세션 이어짐 실패 0 | 미검증 | 어댑터 매핑은 pytest PASS(L1, `QA-FR-BOT-04`). Hermes 런타임 세션 연속성, 특히 브리핑 답글은 README 「Hermes 확인 항목」 4에서 「런타임은 미확인」(`cron.mirror_delivery` 기본 꺼짐이면 브리핑 답글은 새 세션일 가능성 큼) | 영환님: DM 스레드에서 2턴 이상 대화해 앞 턴 내용을 기억하는지 확인. 브리핑 답글 연속성이 필요하면 `cron.mirror_delivery` opt-in 결정 |
| ⑤ | 승인 왕복 1회 이상 성공 | 미검증 | 어댑터 owner 외 `/approve` 무시 pytest PASS(L1), 운영 사람 `/approve`·`/deny` 메시지 0건(L1) — `QA-FR-BOT-06` | 영환님: `QA-FR-BOT-06` 절차 ④ 1회 실행 |
| ⑥ | 어댑터 fatal 0(7일) | 미검증(미시작) | 2026-11-08 22:22 Jarvis DM 왕복 성공, 이후 답글 계속 게시(봇 답글 11-09 7건, L1) — 연결 유지의 간접 증거일 뿐 7일 fatal 로그 점검은 안 함 | Jarvis: 관찰 기간 동안 매일 게이트웨이 로그의 ohmyslack `fatal`(`unauthorized`·`config_invalid`) 0 확인(읽기 전용) |
