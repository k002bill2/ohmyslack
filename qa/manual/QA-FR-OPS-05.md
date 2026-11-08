# QA-FR-OPS-05 — iPhone PWA 브리핑 mp3 재생 (DEV_DESIGN 6-2 FR-OPS-05, 5-4 형식)

> 기준: DEV_DESIGN 6-2 FR-OPS-05 「수동」 열(`iPhone PWA mp3 재생`), W-22 완료 기준(「`QA-FR-OPS-05`는 W-24」), ADR-001 §7 H2(「iPhone PWA에서 브리핑 mp3 재생」)·§3-j 전환 기준 ②.
> 근거 수준: 아래 「실행 불가 원인」은 모두 **L1**(QA가 소스·운영 DB를 직접 확인). 재생 시험 자체는 실행하지 않았습니다.
> 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).

| 필드 | 값 |
|---|---|
| 실행자 | 미실행 / 사전 확인(소스·DB 읽기 전용): Claude(W-24 QA 레인) |
| 일시(KST) | 사전 확인 2026-11-09 02:38–02:40 KST / 재생 시험: 없음 |
| 기기·OS·브라우저(버전) | 예정: iPhone, iOS 16.4+ 홈 화면 PWA(standalone) — 사전 확인은 서버 Mac(arm64) macOS 27.2 |
| 접속 경로 | 예정: tailnet Serve HTTPS(`https://<host>.ts.net/`) 운영 Jarvis DM |
| 절차 | **사전 확인(실행함):** ① 웹 업로드 UI가 mp3를 받는지 — W-22 범위는 이미지 업로드만(DEV_DESIGN W-22 행) ② 어댑터 음성 전송 — `integrations/hermes-plugin/ohmyslack/adapter.py:420-421` `send_voice`가 `_attachment_fallback`(텍스트 대체 안내)로 처리, `__init__.py:16` 「File attachments are not supported yet.」 ③ 운영 DB 오디오 첨부 수(`BEGIN READ ONLY … ROLLBACK`). **재생 시험(미실행, 선행 조건 충족 후):** ④ (개발) W-20 첨부 확장 — 어댑터 `send_voice`가 봇 리스너 업로드 라우트(`apps/server/src/modules/bots/routes.ts:104-113` `…/attachments`)로 mp3를 올리고 메시지에 결속하도록 구현·머지 ⑤ (영환님) 어댑터 배포 후 게이트웨이 재시작 ⑥ (영환님 또는 Jarvis) 브리핑 cron 1회 실행 또는 Jarvis DM에서 음성 브리핑 요청 → DM에 오디오 첨부 메시지 게시 ⑦ (영환님, iPhone) 홈 화면 앱에서 해당 메시지의 오디오 플레이어(CMP-28) 재생 → 끝까지 재생·탐색(seek) 1회 → 캡처 |
| 기대 결과 | iPhone 홈 화면 PWA에서 봇이 보낸 mp3가 재생되고(소리 출력), 탐색 시 Range 요청 206으로 이어 재생, SW 캐시에 첨부가 남지 않음 |
| 실제 결과 | ① 웹에는 mp3 업로드 UI 없음(이미지만) ② 어댑터 `send_voice`는 **아직 텍스트 대체** — 봇 첨부 경로로도 현재 mp3를 보낼 수 없음(서버 봇 업로드 라우트는 존재하나 어댑터가 쓰지 않음) ③ 운영 `attachments` 오디오 **0건**(전체는 `image/png` 2건, 모두 삭제됨) → 재생 대상 자체가 없음. ④–⑦ **미실행** |
| 판정 | `미검증` — 재생 시험 미실행. 차단 요인은 사람 확인만이 아니라 **개발 작업(어댑터 `send_voice` 첨부 구현)** |
| 증거 경로 | (`dev/`는 gitignore — 로컬 보관) `dev/active/p1-w24-qa-cutover/evidence/db-cron-readonly.txt`(`audio_attachments = 0`) · 소스 `integrations/hermes-plugin/ohmyslack/adapter.py:416-428`, `integrations/hermes-plugin/ohmyslack/__init__.py:16`, `apps/server/src/modules/bots/routes.ts:104-113` · 자동 증거: `apps/server/test/attachments/attachments.int.test.ts`(지정), `attachment-headers.int.test.ts`·`apps/web/test/conversation/attachments/audio-attachment.test.tsx`(보조) · 재생 증거: 없음 |
