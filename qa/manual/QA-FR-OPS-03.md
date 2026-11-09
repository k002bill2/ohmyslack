# QA-FR-OPS-03 — Tailscale Serve 쪽 로그 비밀값 점검 (DEV_DESIGN 6-2 FR-OPS-03, TR-SEC-09, 5-4 형식)

> 수동 열 「Tailscale Serve 쪽 로그 점검」의 증거입니다. 2026-11-09 영환님 승인(Slack 「1」, 조회 한정) 범위에서 읽기 전용으로 실행했습니다.
> 설정 변경(`tailscale debug component-logs` 상세 로그 켜기 등)·`sudo`·서비스 중지는 하지 않았습니다. 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).
> 증거에 실제 tailnet 호스트명·IP·카나리 원문·request id를 남기지 않습니다. 카나리는 `<canary>`로 가립니다(가짜 값, 실제 자격 증명 아님).

| 필드 | 값 |
|---|---|
| 실행자 | Claude(QA 레인 p1-g1-qa-ops, 영환님 조회 승인 2026-11-09) — 남은 root 전용 점검은 영환님 실행 필요 |
| 일시(KST) | 2026-11-09 10:20–10:23 KST |
| 기기·OS·브라우저(버전) | 서버 Mac / macOS 27.2 · Tailscale 1.104.5(macsys 네트워크 확장) · `curl`(브라우저 해당 없음) |
| 접속 경로 | tailnet Serve HTTPS(`https://<tailnet-host>`, 같은 Mac에서 호출) → `127.0.0.1:8787` |
| 절차 | 아래 "점검 절차" 1–6번 |
| 기대 결과 | Serve(tailscaled) 쪽 로그와 앱 로그에 요청 본문·쿠키·`Authorization`·봇 토큰(`omsb_`)·push endpoint·쿼리 문자열 비밀값 0건 |
| 실제 결과 | 볼 수 있었던 범위(1·2·3·5)에서 카나리 0건(L1). 단 Serve 쪽은 요청 단위 로그 줄 자체가 관측되지 않아 "가린다"와 "이 상세 수준에서는 안 찍는다"를 구분하지 못함. root 전용 파일 내용·원격 logtail 업로드분·프록시 오류 경로는 미확인 |
| 판정 | `미검증` — 볼 수 없는 영역(4·6)이 남음 |
| 증거 경로 | 이 문서 "점검 절차" 표(가린 출력 인용), `dev/active/p1-g1-qa-ops/REPORT.md`. 자동 증거(경로만): `apps/server/test/ops/log-redaction.int.test.ts`, `pnpm check:log-leak`(`tools/check-log-leak.ts`·`tools/log-canaries.ts`), `apps/server/test/ops/metrics-allowlist.unit.test.ts` |

## 카나리 요청 (2026-11-09 10:20:21 KST, 같은 Mac → Serve HTTPS)

| # | 요청 | 비밀 위치 | 응답 |
|---|---|---|---|
| R1 | `GET /api/me?token=<canary>&endpoint=<canary push URL>` | 쿼리 문자열, `Cookie: sid=<canary>`, `Authorization` 헤더(`omsb_<canary>` 봇 토큰 형식) | 401 |
| R2 | `POST /api/push/subscriptions?k=<canary>` JSON 본문 `endpoint`(가짜 push URL)·`keys.p256dh`·`keys.auth`·`body` 카나리 | 본문, 쿼리, 쿠키, `Authorization` | 403(Origin/CSRF 거부 — 본문 처리 경로까지는 가지 않음) |

## 점검 절차

| # | 점검 | 명령·방법 [조회·승인 필요] | 기대 | 실제 |
|---|---|---|---|---|
| 1 | tailscaled 실시간 로그 | 카나리 전송 전후 약 8초 `tailscale debug daemon-logs`(읽기 전용 스트림, 원격 logtail로 올라가는 것과 같은 로그) 수집 → 카나리 grep | 카나리 0건 | 수집 1줄(`[logtap connected]`)뿐, 카나리 0건, serve/proxy/http 언급 0건(L1). **한계:** 요청 단위 Serve 줄 자체가 안 찍혀 판별력 낮음 — 기본 상세 수준에서는 성공 프록시 요청을 기록하지 않는 것으로 보임(추정, L2) |
| 2 | macOS 통합 로그 | `/usr/bin/log show --start <전송 직전> --predicate 'subsystem BEGINSWITH "io.tailscale" OR process CONTAINS[c] "tailscale"' --info --debug`, 그리고 `process == "io.tailscale.ipn.macsys.network-extension"` 따로 | 카나리 0건 | 178줄(대부분 Tailscale GUI 앱의 CFNetwork·networkextension·XPC 일반 로그), 네트워크 확장 프로세스 15줄. 카나리 0건. 쿠키 관련 3줄은 `NSHTTPCookieStorage` 초기화 문구(요청 값 아님). **한계:** `<private>`로 가려진 값 29건(10:20:15–10:21:00 구간) — macOS가 비공개 처리한 값이라 내용 확인 불가 |
| 3 | 로컬 tailscaled 로그 파일 메타 | `ls -l /Library/Tailscale` (내용 열람 아님) | — | `ipn.log..log1.txt`·`log2.txt` = root 소유 0600, 크기 0바이트, 수정 시각 10:21(카나리 직후). `sockstats.log*` 0바이트. **한계:** 0바이트는 현재 크기일 뿐 — 버퍼가 회전·업로드됐을 가능성이 있어 "기록된 적 없음"의 증거가 아님. 내용은 `sudo` 필요(미실행) |
| 4 | 원격 logtail·관리 콘솔 로그 | 관리 콘솔(로그 스트리밍·네트워크 플로 로그 설정) | 요청 내용 미포함 | (미실행 — 로컬에서 볼 수 없음. 사람 필요) |
| 5 | 앱 쪽 로그(보조) | `/Users/younghwankang/Work/ohmyslack/.claude/logs/server.log`·`server.err.log` 읽기만, 키 이름 집계·패턴 건수만(원문 출력 없음) | 비밀 패턴 0건, PRD §10 허용 키만 | `server.log` 189줄 전부 JSON. 키 7종만: `event`·`method`·`route`·`status_code`·`duration_ms`·`request_id`·`error_code`. 이벤트 `http_request` 183·`push_send_result` 6. 패턴 건수 cookie 0·authorization/bearer 0·`omsb_` 0·push endpoint URL 0·쿼리 문자열 0·password 0·sid/session/token 키 0·카나리 0. `route`는 원문 URL이 아닌 라우트 템플릿(R1의 쿼리 미기록). `server.err.log` 0바이트, 카나리 0(L1) |
| 6 | 프록시 오류 경로 | 백엔드 중지 상태에서 Serve 요청 → tailscaled 오류 로그에 URL·쿼리가 찍히는지 | 쿼리·헤더 미포함 | (미실행 — 서비스 중지 금지 범위) |

## 남은 절차 (확인 필요 — 영환님 실행)

1. 터미널에서 카나리 요청 R1을 다시 보낸 직후 `sudo grep -c '<canary>' /Library/Tailscale/ipn.log*` → `0` 확인(파일이 회전됐으면 `ls -l` 크기·시각도 함께 기록).
2. 관리 콘솔 Logs(설정 감사 로그·네트워크 플로 로그·로그 스트리밍)에서 활성 여부를 확인하고, 켜져 있으면 요청 경로·쿼리·헤더 값이 포함되는지 확인.
3. (선택, 설정 변경이므로 영환님 판단) `tailscale debug component-logs` 상세 로그를 잠시 켜고 1번을 반복한 뒤 끔.
4. 프록시 오류 경로(점검 절차 6): 서비스 중지가 필요하므로 별도 승인 후 영환님이 `launchctl` 로 앱을 잠시 멈춘 상태에서 카나리 요청 R1을 보내고(502 등 기대) 1번의 `sudo grep`·`tailscale debug daemon-logs`로 URL·쿼리·헤더 카나리가 0건인지 확인 → 앱 재기동.
5. 위 1·2·4가 모두 0건일 때만 판정을 `PASS`로 바꾸고 실행자·일시를 기입. 4를 하지 않기로 하면 그 범위를 「실제 결과」에 별도 미검증으로 명시하고 Jarvis 판단을 받습니다(그 전에는 `미검증` 유지).

하나라도 비밀값이 보이면 판정 `FAIL`, 해당 로그를 보존 범위에서 지우는 절차는 별도 승인으로 진행합니다.
