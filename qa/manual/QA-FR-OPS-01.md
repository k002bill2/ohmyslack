# QA-FR-OPS-01 — tailnet 전용 노출 경계 (DEV_DESIGN 6-2 FR-OPS-01, 5-4 형식)

> 절차 1·2·3·4·6·8은 2026-11-09 영환님 승인(Slack 「1」, 조회 한정) 후 서버 Mac에서 실행했습니다(L1). 5·7은 사람이 필요해 미실행입니다. 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).
> 모든 점검 명령은 **[조회·승인 필요]**입니다 — 영환님 승인 후 실행합니다. 설정 변경은 이 QA 범위가 아닙니다(`docs/runbooks/TAILSCALE_SERVE.md`).
> 증거에 실제 tailnet 호스트명·IP·비밀 값을 남기지 않습니다. `<tailnet-host>`·`<port>`처럼 가려서 기록합니다.

| 필드 | 값 |
|---|---|
| 실행자 | Claude(QA 레인 p1-g1-qa-ops, 영환님 조회 승인 2026-11-09) — 5·7은 영환님 실행 필요 |
| 일시(KST) | 2026-11-09 10:18–10:21 KST(절차 1·2·3·4·6·8). 1·3·4는 같은 날 01:51 KST 1차 실행 기록도 아래 유지 |
| 기기·OS·브라우저(버전) | 서버 Mac / macOS 27.2 · Tailscale CLI 1.104.5(macsys 네트워크 확장) · `curl`·`nc`(브라우저 렌더 미확인) — tailnet 밖 기기·iPhone: (미실행) |
| 접속 경로 | localhost(서버 Mac, `127.0.0.1:<port>`) / tailnet Serve HTTPS(`https://<tailnet-host>`) / tailnet 밖·LAN 직접 접근(실패 기대) |
| 절차 | 아래 "점검 절차" 1–8번 |
| 기대 결과 | ① 앱 리스너가 `127.0.0.1:<port>` 하나뿐 ② PG 리스너가 `127.0.0.1:5432`뿐 ③ Funnel 항목 0건 ④ Serve 대상이 `127.0.0.1:<port>` 하나뿐, 5432 없음 ⑤ tailnet 밖 기기·LAN 직접 접근 실패 ⑥ tailnet 기기 Serve HTTPS 접근은 로그인 화면(로그인 생략 없음) ⑦ ACL·공유 노드 점검 기대 충족 ⑧ tailnet 기기에서 Serve HTTPS 외 직접 경로(앱 포트·5432·80) 접근 실패 |
| 실제 결과 | 1·2·3·4·6·8 기대 충족(아래 표, L1). 5·7 미실행 |
| 판정 | `미검증` — 5(tailnet 밖·LAN 기기)·7(ACL 관리 콘솔)이 남음 |
| 증거 경로 | 이 문서 "점검 절차" 표의 가린 명령 출력 인용, `dev/active/p1-g1-qa-ops/REPORT.md` 실행 명령·EXIT 절. 자동 증거: `apps/server/test/ops/bind.int.test.ts`·`apps/server/test/bots/bot-listener-bind.int.test.ts` |

## 점검 절차

| # | 점검 | 명령·방법 [조회·승인 필요] | 기대 | 실제 |
|---|---|---|---|---|
| 1 | 리스너 loopback 한정 | 서버 Mac: `lsof -nP -iTCP -sTCP:LISTEN` (부재 판정 보강: `sudo lsof -nP -iTCP -sTCP:LISTEN` 또는 `netstat -anv -p tcp \| grep LISTEN` — 일반 권한 `lsof`는 타 사용자 소켓을 숨길 수 있음, **확인 필요**) | 앱 `127.0.0.1:<port>`만. `*:`·`0.0.0.0:`·`[::]:`·LAN IP 리스너로 앱 포트가 보이지 않음 | **2026-11-09 10:18 KST 재실행(L1):** `netstat -anv -p tcp` LISTEN 중 8787·8788·5432 줄 = `tcp4 127.0.0.1.8787`·`tcp4 127.0.0.1.8788`·`tcp4 127.0.0.1.5432` 각 1건, 세 포트의 `*`·`::` 리스너 0건. `lsof`(일반 권한)도 `node 127.0.0.1:8787`·`node 127.0.0.1:8788`·`com.docke 127.0.0.1:5432`. 앱은 launchd `com.ohmyslack.server`(상태 0). → 앱 8787·봇 8788 모두 loopback 한정. **관찰:** `*.443`(tcp4·tcp6) 와일드카드 리스너가 있으며 소유 프로세스는 `io.tailscale.ipn`(Tailscale 네트워크 확장, Serve 접점). 같은 Mac에서 자기 LAN IP로 `nc -z <lan-ip> 443` = TCP 거부, 8787·8788·5432·80도 거부(보조 증거, 5번 대체 아님). 01:51 KST 1차: 앱 `127.0.0.1:8787` 1건, 와일드카드 리스너는 앱과 무관한 프로세스뿐(ControlCenter 5000·7000, rapportd, Orca 6768, astxAgent, CrossEX). **한계:** `sudo lsof` 미실행(금지 범위) |
| 2 | PG 바인드 | 같은 출력에서 `:5432` 줄 (보조: `docker port <pg 컨테이너>`) | `127.0.0.1:5432`만(TRD §5-1 S13) | `127.0.0.1:5432` 1건(`com.docker.backend`), tcp6·와일드카드 없음(10:18 KST 재확인, L1) |
| 3 | Funnel off | `tailscale funnel status` | 공개 항목 0건 | 10:19 KST: `tailscale funnel status` = `https://<tailnet-host> (tailnet only)` / `\|-- / proxy http://127.0.0.1:8787` 뿐. `serve status --json` 최상위 키 `TCP`·`Web`만, `AllowFunnel` 없음 → 공개 항목 0건(L1) |
| 4 | Serve 대상 | `tailscale serve status` | `https://<tailnet-host>` → `http://127.0.0.1:<port>` 1건. 5432·기타 포트 대상 없음 | 10:19 KST: `https://<tailnet-host> (tailnet only)` → `/ proxy http://127.0.0.1:8787` 1건. JSON `TCP` = `443`(HTTPS)만, Web 핸들러 `/` 1건. 5432·8788·기타 포트 대상 없음(L1) |
| 5 | tailnet 밖·LAN 접근 실패 | tailnet에 없는 기기(같은 LAN)에서 `http://<맥 LAN IP>:<port>/`·`http://<맥 LAN IP>:5432`, 그리고 tailnet 밖 기기에서 `https://<tailnet-host>/` 접속 시도 | 모두 연결 실패(거부·시간 초과·이름 해석 실패). 응답 본문 0 | (미실행 — 사람 필요. 절차: ① tailnet에 없는 기기(예: Tailscale 끈 iPhone, Wi‑Fi 같은 LAN)에서 Safari로 `http://<맥 LAN IP>:8787/`·`http://<맥 LAN IP>:8788/`·`https://<맥 LAN IP>/` 열기 → 모두 연결 실패 ② 같은 기기 셀룰러(LAN 밖)에서 `https://<tailnet-host>/` → 이름 해석 실패 또는 연결 실패 ③ 응답 본문이 하나라도 보이면 `FAIL`. 맥 LAN IP는 맥 "시스템 설정 > 네트워크"에서 확인, 증거엔 `<lan-ip>`로 가림. 같은 Mac 자기 LAN IP 거부 관찰은 1번 참조 — 보조일 뿐) |
| 6 | tailnet 기기 접근·로그인 유지 | tailnet 기기 브라우저로 `https://<tailnet-host>/` | HTTPS로 열리고 로그인 화면 표시. tailnet 접근만으로 로그인 생략 안 됨 | 10:19 KST, 서버 Mac(자신이 tailnet 기기)에서 `curl`(L1): `https://<tailnet-host>/` = HTTP 200, `text/html`, TLS 검증 결과 0(정상), 본문에 `<title>메신저</title>`·`<div id="root"`(SPA 셸, 1010바이트). 쿠키 없이 `GET /api/me`·`GET /api/sessions` = **401**(`unauthenticated`) → tailnet 접근만으로 인증 생략 안 됨. **범위 밖:** 실제 브라우저 렌더(로그인 화면 표시)는 미확인 — 다른 tailnet 기기(iPhone) 확인은 실기 체크리스트에서. 참고: `http://127.0.0.1:8787/` 직접 `curl`은 400(Host 검사로 추정, **확인 필요**) |
| 7 | ACL·공유 노드 | 런북 4절 A1–A7 | 본인 기기·계정만, 외부 공유 0건, funnel 속성 미부여 | (미실행 — 관리 콘솔 사람 필요. 절차: 런북 4절 A1–A7을 관리 콘솔 Machines·Users·Access controls에서 확인하고 항목별 기대 충족 여부를 적음. A7은 nodeAttrs에 이 노드 `funnel` 속성 없음) |
| 8 | Serve HTTPS만 허용(tailnet 안 우회 경로 차단) | tailnet 기기에서 `curl -m 5 http://<tailnet-host>:<port>/`, `nc -vz -w 5 <tailnet-host> 5432`, `curl -m 5 http://<tailnet-host>/`(80) | 앱 포트·5432 연결 실패. 80은 연결 실패 또는 HTTPS로만 안내(앱 본문 응답 없음 — Serve 동작은 **확인 필요**) | 10:19 KST, 경로 = **같은 Mac → 자기 tailnet 호스트명**(다른 tailnet 기기 경로 아님, L1): `http://<tailnet-host>:8787/` = curl (7) Couldn't connect, `http://<tailnet-host>:8788/` = curl (7), `nc -vz <tailnet-host> 5432` = Connection refused(tailnet IPv4 `<ts-ip>` 직접도 refused), `http://<tailnet-host>/`(80) = curl (7) Couldn't connect. 앱 본문 응답 0 |

하나라도 기대와 다르면 판정 `FAIL`, 런북 6절 롤백을 먼저 하고 원인을 기록합니다.
