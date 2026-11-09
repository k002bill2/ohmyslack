# QA-FR-OPS-05 — iPhone PWA 브리핑 mp3 재생 (DEV_DESIGN 6-2 FR-OPS-05, 5-4 형식)

> 기준: DEV_DESIGN 6-2 FR-OPS-05 「수동」 열(`iPhone PWA mp3 재생`), W-22 완료 기준(「`QA-FR-OPS-05`는 W-24」), ADR-001 §7 H2(「iPhone PWA에서 브리핑 mp3 재생」)·§3-j 전환 기준 ②.
> 근거 수준: **L1** = QA가 운영 DB(`BEGIN READ ONLY … ROLLBACK`)·운영 서버 로그(읽기만)를 직접 확인 / **L2** = Jarvis 제공 기록·영환님 실기 확인. **iPhone에서의 재생·탐색(소리·체감)은 L2**이며 QA가 실기기를 직접 본 것은 아닙니다.
> 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).
> 이전 판정(2026-11-09 02:40, W-24 레인): `미검증` — 어댑터 `send_voice` 텍스트 대체, 운영 오디오 첨부 0건. W-20b(`eb4a1d8`) 머지·배포로 차단 해소.

| 필드 | 값 |
|---|---|
| 실행자 | 재생 시험: 영환님(iPhone 실기, L2), 기록 Jarvis(L2) / 서버측 확인(DB·로그 읽기 전용): Claude(W-24b QA 레인, L1) |
| 일시(KST) | 재생 시험 2026-11-09 09:20:59–09:26:04(L2) / QA 확인 2026-11-09 09:40–09:45 |
| 기기·OS·브라우저(버전) | iPhone 홈 화면 PWA(standalone) — OS 버전은 이번 기록에 없음(이전 기록 iOS 18.7, L2) / 서버 Mac(arm64) macOS 27.2 |
| 접속 경로 | 운영 tailnet Serve HTTPS(`https://<host>.ts.net/` → `127.0.0.1:8787`) Jarvis DM, 봇 리스너 `127.0.0.1:8788` |
| 절차 | ① (L2) 09:17 게이트웨이 재시작 — W-20b 어댑터 로드(`adapter.cpython-314.pyc` 재생성), 운영 어댑터 `eb4a1d8`·서버 `b655ddd`와 동일 tree ② (L2) 09:20:59 iPhone Jarvis DM 「오늘 브리핑 음성으로 보내줘」 → 09:21:43 답글에 mp3 첨부(게이트웨이 로그 「Delivering 1 non-image MEDIA attachment(s)」) → iPhone에서 재생·탐색 ③ (L2) 09:25:43 iPhone에서 png 첨부 메시지 → 어댑터가 봇 토큰으로 다운로드 → Hermes 「Image routing: native… 1 image(s)」 → 09:26:04 설명 답글 ④ (L1) 운영 DB `attachments`·`messages`·`users`·`attachment_blobs` 읽기 전용 조회(mime·크기·길이·결속 여부만, 본문 원문 미출력) ⑤ (L1) 운영 서버 로그 `server.log`(3,110줄, JSON) 첨부 라우트 집계와 본문·URL·토큰 패턴 검사(`python3 -I` 집계 스크립트) |
| 기대 결과 | iPhone 홈 화면 PWA에서 봇이 보낸 mp3가 재생되고(소리 출력), 탐색 시 Range 요청 206으로 이어 재생, SW 캐시에 첨부가 남지 않음 |
| 실제 결과 | **재생(L2):** 영환님 iPhone에서 재생·탐색 정상(「완료」). **DB(L1):** 2026-11-09 09:21:43 `audio/mpeg` 1,188,864 B·`duration_ms` 198,144(약 3분 18초), 업로더 `kind=bot`, 답글 메시지(09:21:43, 본문 15자)에 결속, 미삭제, blob 1행. 09:25:36 `image/png` 1,026,797 B·1206×2622, 업로더 `kind=human`, 최상위 메시지(09:25:43, 본문 8자)에 결속, blob 1행. 미결속·미삭제 첨부 0, 전체 오디오 첨부 1건. **서버 로그(L1):** 봇 업로드 줄(`POST /api/bot/v1/attachments` 201 ×1) 이후 `GET /api/attachments/:id` **206 ×3**·200 ×5, `POST /api/attachments` 201 ×1, `GET /api/bot/v1/attachments/:id` 200 ×1. 로그 전체 누계는 `GET /api/attachments/:id` 200 ×12·206 ×3, `POST /api/attachments` 201 ×5(이전 이미지 시험 포함). 로그 필드는 `event·method·route·status_code·duration_ms·request_id·error_code`뿐 — 경로는 `:id` 템플릿, 본문·URL·토큰·`Authorization`·쿠키 패턴 0줄. **한계:** 로그에 시각·첨부 id가 없어 206 3줄이 오디오 요청임은 「봇 mp3 업로드 직후 Range 응답, 이미지 표시는 200」이라는 정황으로만 연결(첨부 단위 귀속은 미확인). Jarvis 집계 `POST /api/attachments` 201 ×2와 QA 창 집계 ×1이 다름(집계 구간 차이로 추정, 미확인). **SW 캐시 미잔존은 실기기에서 확인하지 않음(미검증)** — 자동 증거 `check:no-persist-cache`(W-22)·`attachment-headers.int.test.ts`(no-store)에만 의존 |
| 판정 | `PASS` — 기준(DEV_DESIGN 6-2 FR-OPS-05 수동 열 「iPhone PWA mp3 재생」) 충족. 근거: 재생·탐색 체감은 영환님 실기 L2, 봇 mp3 첨부 행·메시지 결속·blob 존재와 Range 206 응답은 QA L1. 기대 결과 중 「SW 캐시에 첨부가 남지 않음」은 실기 미검증(자동 증거만). 브리핑 cron 자체가 보낸 mp3가 아니라 DM 요청으로 생성된 음성 브리핑임 |
| 증거 경로 | (`dev/`는 gitignore — 로컬 보관) `dev/active/p1-w24b-qa-ops05/evidence/db-attachments-readonly.txt`·`db-bot-messages-readonly.txt`·`server-log-attachments.txt`·`fr-coverage.txt` · 운영 로그 `~/.hermes/profiles/jarvis/cache/scratch/ohmyslack-run/server.log`(읽기만) · 게이트웨이 로그 줄은 Jarvis 제공(L2, QA 미열람) · 자동 증거: `apps/server/test/attachments/attachments.int.test.ts`(지정), `attachment-headers.int.test.ts`·`apps/web/test/conversation/attachments/audio-attachment.test.tsx`(보조) · 재생 화면 캡처: 없음(영환님 구두 확인) |
