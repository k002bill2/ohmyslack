# QA-FR-BOT-02 — 봇 포트가 Serve에 노출되지 않음 (DEV_DESIGN 6-2 FR-BOT-02, 5-4 형식)

> 기준: DEV_DESIGN 6-2 FR-BOT-02 「수동」 열(`Serve 설정에 봇 포트 없음 확인`), 경계 규칙 B9(봇 리스너 루프백 전용), TRD R3.3 §5-2.
> 근거 수준: 아래 결과는 모두 **L1**(QA가 직접 명령 실행·출력 확인). 설정은 읽기만 했고 바꾸지 않았습니다.
> 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).

| 필드 | 값 |
|---|---|
| 실행자 | Claude(W-24 QA 레인, 읽기 전용 명령) |
| 일시(KST) | 2026-11-09 02:36–02:40 KST |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) / macOS 27.2 / Tailscale 1.104.5 / 브라우저 해당 없음(명령 출력 확인) |
| 접속 경로 | 서버 Mac 로컬 셸(`tailscale serve status`·`lsof`) — 대상은 tailnet Serve HTTPS 설정과 운영 서버 PID 90174의 리스닝 소켓 |
| 절차 | ① `tailscale serve status`로 Serve 매핑 전체 확인(호스트명은 증거 파일에서 가림) ② `lsof -nP -iTCP:8788 -sTCP:LISTEN`으로 봇 포트 바인딩 주소 확인 ③ `lsof -nP -iTCP:8787 -sTCP:LISTEN`과 같은 PID의 모든 TCP LISTEN 소켓 나열(`*`·`[::]` 바인딩 유무) |
| 기대 결과 | Serve 매핑에 8788(봇 포트)이 없고 메인 포트 8787만 프록시됨, Funnel(공개) 아님, 8788은 `127.0.0.1`에만 LISTEN(`*`·`0.0.0.0`·`[::]` 없음) |
| 실제 결과 | ① `https://<host>.ts.net (tailnet only)` 아래 `/ proxy http://127.0.0.1:8787` 한 줄뿐. 8788 매핑 없음, 「tailnet only」라 Funnel 아님. EXIT 0 ② `node 90174 IPv4 TCP 127.0.0.1:8788 (LISTEN)` 한 줄 ③ 8787도 `127.0.0.1:8787 (LISTEN)`. PID 90174의 TCP LISTEN은 `127.0.0.1:8787`·`127.0.0.1:8788` 둘뿐이고 IPv6·와일드카드 바인딩 없음 |
| 판정 | `PASS` |
| 증거 경로 | (`dev/`는 gitignore — 로컬 보관) `dev/active/p1-w24-qa-cutover/evidence/bot-02-serve-lsof.txt`(명령 출력, 호스트명 가림) · 자동 증거: `apps/server/test/bots/bot-token.int.test.ts`(지정), `apps/server/test/bots/bot-listener-bind.int.test.ts`(보조: 루프백 전용·`/api/bot/v1/**` 외 404) |
