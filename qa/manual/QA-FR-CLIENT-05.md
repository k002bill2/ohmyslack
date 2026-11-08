# QA-FR-CLIENT-05 — iPhone 홈 화면 PWA Web Push 실기 수신 (DEV_DESIGN 6-2 FR-CLIENT-05, 5-4 형식)

> 기준: DEV_DESIGN 6-2 FR-CLIENT-05 「수동」 열(`iOS 16.4+ 홈 화면 PWA·tailnet origin 실기 수신`), W-23 완료 기준, ADR-001 §7 H3(「tailnet origin 실기 수신 확인」)·D-3.
> 근거 수준: **L1** = QA(Claude, W-24 레인)가 직접 실행·관찰 / **L2** = Jarvis가 남긴 실기 기록(영환님 육안 확인 전달). 실기기 화면 수신은 QA가 직접 보지 못했으므로 **L2**입니다.
> 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).

| 필드 | 값 |
|---|---|
| 실행자 | 실기기 조작·수신 육안 확인: 영환님(실기기), 기록: Jarvis (L2) / 서버측 대조(로그·DB 읽기 전용): Claude(W-24 QA 레인) (L1) |
| 일시(KST) | 실기 2026-11-09 00:28–00:37(선행 spike) · 01:28–01:40(운영 `126e07a`) · 02:33(운영 `b655ddd`) (L2) / 서버측 대조 2026-11-09 02:40 KST (L1) |
| 기기·OS·브라우저(버전) | iPhone, iOS 18.7, 홈 화면 PWA(standalone) — iOS 버전은 spike 기록에만 명시되어 있고 운영 01:28·02:33 시험 기기가 같은 기기·버전이라는 것은 추정(L2) / 서버: Mac(arm64) macOS 27.2, 운영 서버 PID 90174(02:30:39 기동) |
| 접속 경로 | tailnet Serve HTTPS(`https://<host>.ts.net/`, tailnet only → `127.0.0.1:8787`) |
| 절차 | ① (spike) `*.ts.net/push-spike/` 홈 화면 PWA에서 standalone 확인 → 알림 권한 요청 → 구독 → 서버 전송 ② (운영 126e07a) 홈 화면 앱 사이드바 「알림 켜기」 → 구독 1건 → Jarvis DM에서 봇 답글 유발 → 알림 표시 확인 ③ (운영 b655ddd, W-23b) 앱 강제 종료 없이 열기→홈 화면 → Jarvis DM 봇 답글 → 알림 표시 확인 ④ (QA L1) 운영 서버 로그 `push_send_result` 줄 수·필드 형식 확인 ⑤ (QA L1) `push_subscriptions` 행 수·endpoint 호스트·`last_success_at`를 `BEGIN READ ONLY … ROLLBACK`로 조회(endpoint 원문 비출력) |
| 기대 결과 | iOS 16.4+ 홈 화면 PWA·tailnet origin에서 구독 성공, 봇 답글 1건당 본문 없는 payload 알림 1건이 실기기에 표시, 서버 로그에 본문·endpoint가 남지 않음, endpoint 호스트는 허용목록(Apple) |
| 실제 결과 | **L2(Jarvis 기록):** ① standalone=true → 권한 granted → 구독 host `web.push.apple.com` → Apple 201 → 영환님 실기기 수신 확인 ② 01:28 구독 1건. 01:29·01:35 답글 푸시는 Apple 201인데 **미표시**(원인 추정: 새 SW가 waiting 상태라 push 핸들러 없는 옛 SW가 수신). 앱 완전 종료·재실행 후 01:40 수신(영환님 확인) ③ 02:33 강제 종료 없이 답글 푸시 Apple 201 → 수신(영환님 「알림와」). **L1(QA 직접):** ④ `server.log` `push_send_result` **5줄**, 각 줄 키는 `event`·`error_code`·`status_code` 3개뿐, 값은 모두 `error_code=sent`·`status_code=201`. URL·endpoint·키·본문 문자열 포함 줄 0. 줄에 시각 필드가 없어 5줄과 Jarvis 기록의 운영 전송 4회(01:29·01:35·01:40·02:33)를 1:1로 대응시킬 수 없음 — **1줄 차이는 원인 미확인** ⑤ `push_subscriptions` 1행, host `web.push.apple.com`, created 2026-11-09 01:28:52, `last_success_at` 2026-11-09 02:33:36(Jarvis 기록 02:33:36과 일치). **주의:** Apple 201은 「Apple이 받음」이지 「화면 표시」가 아님(01:29·01:35가 그 반례). 화면 표시는 L2(영환님 육안)로만 확인됨 |
| 판정 | `PASS` — 근거: 실기기 표시는 영환님이 실행·육안 확인한 L2 기록(02:33, 최신 운영 빌드 `b655ddd`), 서버측 전송 201·구독 1행·`last_success_at` 일치·로그 무본문은 QA L1. QA가 실기기 화면을 직접 본 것은 아님 |
| 증거 경로 | (`dev/`는 gitignore — 로컬 보관) L1: `dev/active/p1-w24-qa-cutover/evidence/client-05-push-log.txt`(로그 요약), `dev/active/p1-w24-qa-cutover/evidence/db-cron-readonly.txt`(구독 SQL) · L2: 메인 체크아웃 `dev/handoff/HANDOFF-2026-11-08.md` 101·105·106·109행, spike 캡처 `design/attachments/40–71`(Jarvis 보관) · 자동 증거: `apps/server/test/push/push.int.test.ts`(지정), `apps/web/test/pwa/push-handler.test.ts`(보조) |
