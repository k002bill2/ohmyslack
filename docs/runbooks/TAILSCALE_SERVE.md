# 런북 — Tailscale Serve 노출·맥 상시 구동 (W-12, FR-OPS-01, TR-SEC-07)

> 정본: TRD R3.2 §6(Serve HTTPS만·Funnel 금지·127.0.0.1 바인드·DB 포트 비노출), §5-1 S13, TR-SEC-07 /
> DEV_DESIGN W-12·⚖️-5·§5-4·6-2 FR-OPS-01 행 / THREAT_MODEL §6 #11·#12 / PRD FR-OPS-01.
>
> **이 문서는 적용을 승인하지 않습니다(DEV_DESIGN ⚖️-5).** Tailscale·launchd·전원·방화벽 설정의 조회·변경은
> 영환님이 직접 하거나 영환님 승인 후에만 합니다. 작성 시점에 어떤 설정도 조회·변경하지 않았습니다.
>
> 이 문서는 값을 담지 않습니다. `<port>`·`<tailnet-host>`·`<기기 이름>` 같은 자리표시자는 실행할 때 사람이 채웁니다.
> 실제 tailnet 호스트명·비밀번호·접속 문자열·인증 키를 이 문서나 QA 증거에 적지 않습니다.

## 표기

각 명령에는 다음 중 하나를 붙입니다.

| 표기 | 뜻 |
|---|---|
| **[조회·승인 필요]** | 상태를 바꾸지 않지만 Tailscale·네트워크·시스템 상태를 읽습니다. 에이전트는 승인 없이 실행하지 않습니다 |
| **[변경·승인 필요]** | 설정을 바꿉니다. 영환님 승인 후 영환님이 실행합니다 |
| **[로컬·승인 불필요]** | 저장소 안 파일만 다룹니다 |

명령 문법은 작성 시점 기억에 근거한 **예시**입니다. 실행 전 TRD §9의 공식 문서
(Serve CLI: https://tailscale.com/docs/reference/tailscale-cli/serve, 예시: https://tailscale.com/docs/reference/examples/serve)와
설치된 `tailscale version`의 `tailscale serve --help` 출력으로 대조합니다(**확인 필요**).

## 0. 전제와 금지 사항

전제

1. 앱(Fastify)은 단일 프로세스이고 listener는 `127.0.0.1:<port>` 하나입니다(TRD §6, FR-OPS-01 지정 테스트 `apps/server/test/ops/bind.int.test.ts` — 작성 시점 미존재, 예정).
2. tailnet HTTPS 접점은 Tailscale Serve만 제공합니다. 앱 인증은 tailnet 접근과 별개로 항상 유지합니다(Serve hostname은 비밀이 아님).
3. PostgreSQL(shared-postgres)은 `127.0.0.1:5432`에만 바인드돼 있습니다(TRD §5-1 S13, 2026-11-07 `docker port` 확인 사실). Serve 대상이 아닙니다.
4. 앱 기동 진입점(서버 시작 명령)은 W-06 이후 확정됩니다. 아래 `<서버 시작 명령>`은 **확인 필요** 자리표시자입니다.

금지(하나라도 해당하면 노출 중단 → 6절 롤백)

- Tailscale **Funnel**(공인 인터넷 노출)
- 공유기 포트 포워딩, LAN 인터페이스 바인드, `0.0.0.0`·`::` listener
- DB 포트(5432)를 Serve·Funnel·포트 포워딩 대상으로 지정
- tailnet 신원 헤더(Tailscale identity header)를 인증·로그인 제한 키로 신뢰(TRD §5-1 S1)
- 타인 기기 tailnet 추가·노드 공유(별도 승인 사항, TRD §1)

## 1. 앱 기동 (127.0.0.1:<port>)

1. **[로컬·승인 불필요]** Node 경로: `export PATH=$HOME/.nvm/versions/node/v26.13.0/bin:$PATH`
2. **[변경·승인 필요]** 운영 환경변수는 사람이 셸에서 직접 로드합니다(에이전트는 운영 `.env`를 열지 않습니다).
3. **[변경·승인 필요]** `<서버 시작 명령>`으로 기동합니다. 바인드 주소를 바꾸는 설정·인자를 넘기지 않습니다(설계상 기본값 127.0.0.1 — 구현은 W-06 이후 `bind.int.test.ts`로 확인 필요).
4. **[조회·승인 필요]** 리스너가 loopback뿐인지 확인합니다.
   ```sh
   lsof -nP -iTCP -sTCP:LISTEN | grep -E ':<port>|:5432'
   ```
   기대: 두 줄 모두 `127.0.0.1:<port>`·`127.0.0.1:5432`. `*:`·`0.0.0.0:`·`[::]:`·LAN IP가 보이면 중단합니다.
5. **[조회·승인 필요]** 로컬 응답 확인: `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/`

## 2. Serve HTTPS 설정 (예시 — 실행하지 않음)

1. **[조회·승인 필요]** 현재 상태 기록(변경 전 스냅샷, 롤백 기준):
   ```sh
   tailscale status
   tailscale serve status
   tailscale funnel status
   ```
2. **[변경·승인 필요]** tailnet HTTPS 443 → 로컬 앱으로 프록시(백그라운드 유지):
   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:<port>
   ```
   - 대상은 반드시 `127.0.0.1:<port>`(앱)입니다. `5432`나 다른 포트를 지정하지 않습니다.
   - tailnet에서 HTTPS 인증서가 꺼져 있으면 관리 콘솔에서 MagicDNS·HTTPS 인증서를 켜야 할 수 있습니다(**확인 필요**, 변경·승인 필요).
3. **[조회·승인 필요]** 적용 결과 확인: `tailscale serve status` — 항목이 `https://<tailnet-host>` → `http://127.0.0.1:<port>` **하나뿐**이어야 하고 Funnel 표시가 없어야 합니다.

## 3. Funnel 꺼짐 확인

1. **[조회·승인 필요]** `tailscale funnel status` — 공개(Funnel) 항목 0건이어야 합니다.
2. **[조회·승인 필요]** `tailscale serve status` 출력에 Funnel/"Available on the internet" 류 표시가 없는지 확인합니다(출력 문구는 버전별로 다를 수 있음 — **확인 필요**).
3. Funnel 항목이 보이면 **[변경·승인 필요]** `tailscale funnel reset`(또는 해당 포트 `off`)으로 끄고 6절 절차를 따릅니다(문법 **확인 필요**).

## 4. tailnet ACL·공유 노드 점검 (THREAT_MODEL §6 #12)

판정 기준: "허용 tailnet 기기"(PRD FR-OPS-01) = 영환님 본인 계정 소유 기기만. 아래는 관리 콘솔 또는 CLI로 사람이 확인합니다.

| # | 점검 항목 | 방법 | 기대 |
|---|---|---|---|
| A1 | tailnet 기기 목록 | **[조회·승인 필요]** `tailscale status` / 관리 콘솔 Machines | 본인 기기(`<기기 이름>`)만 존재. 모르는 기기 0 |
| A2 | 사용자 목록 | **[조회·승인 필요]** 관리 콘솔 Users | 본인 계정만. 초대 대기 0 |
| A3 | 노드 공유(share) | **[조회·승인 필요]** 관리 콘솔에서 이 맥 노드의 Share 상태 | 외부 공유 0건. 공유된 노드는 Serve 주소에 닿을 수 있음(TM-NET-04) |
| A4 | ACL 정책 | **[조회·승인 필요]** 관리 콘솔 Access controls | 이 맥 443 접근 허용 대상이 본인 기기·본인 계정뿐. 기본 allow-all이면 단일 사용자 tailnet에 한해 허용, 사용자·공유가 늘기 전 좁힘 |
| A5 | 이 맥에 들어온 공유 노드 | **[조회·승인 필요]** `tailscale status`에서 타 tailnet 공유 노드 표시 | 0건 또는 본인 소유만 |
| A6 | 키 만료·태그 | **[조회·승인 필요]** 관리 콘솔 | 이 맥 노드 키 만료 시점 기록(만료 시 접속 불가 — 7절) |

ACL 수정·공유 해제는 **[변경·승인 필요]**입니다. 타인 기기 추가는 별도 승인 전까지 하지 않습니다.

## 5. 맥 잠자기·상시 구동 방식 (DEV_DESIGN ⚖️-5, R-04)

맥이 잠들거나 꺼지면 모든 기기가 접속할 수 없습니다(NFR-08: 공용 SLA 없음). UI는 연결 끊김을 표시합니다.

| 항목 | A. launchd 사용자 에이전트(LaunchAgent) | B. 수동 기동(터미널) |
|---|---|---|
| 위치·권한 | `~/Library/LaunchAgents/<label>.plist`, 로그인 사용자 권한(root 아님) | 터미널 세션 |
| 재부팅·로그인 후 | 로그인 시 자동 기동(`RunAtLoad`) | 사람이 다시 실행 |
| 크래시 후 | `KeepAlive`로 재시작(재시작 폭주 방지 `ThrottleInterval`) | 멈춘 채 유지 |
| 로그아웃 시 | 중지(사용자 세션 종속) | 중지 |
| 비밀 로딩 | plist에 비밀 값을 넣지 않음. 래퍼 스크립트가 권한 600 파일에서 로드(**설계 확인 필요**) | 사람이 셸에서 로드 |
| 잠자기 | 막지 못함 — 전원 설정 별도 | 막지 못함 |
| 감사·롤백 | `launchctl bootout`으로 즉시 중지, plist 삭제로 원복 | 프로세스 종료 |

**★ 권고: A. launchd 사용자 에이전트(LaunchAgent).** 이유:
1. 재부팅·크래시 후에도 사람 개입 없이 같은 명령·같은 바인드(127.0.0.1)로 기동돼, 수동 기동 때 생기는 인자 실수(LAN 바인드 등) 여지가 줄어듭니다.
2. 사용자 권한으로 돌아 LaunchDaemon(root)보다 권한이 작고, 비밀 파일 접근 범위가 영환님 계정으로 한정됩니다.
3. `launchctl bootout` 한 줄로 즉시 멈추고 plist 삭제로 완전히 원복됩니다.

잠자기는 두 방식 모두 별도입니다. 전원 연결 시 시스템 잠자기를 끄는 설정(시스템 설정 > 에너지, 또는 `pmset -c sleep 0`)은 **[변경·승인 필요]**이며 디스플레이 잠자기는 유지해도 됩니다.
적용(plist 작성·`launchctl bootstrap gui/$(id -u) <plist>`·전원 설정)은 W-06 서버 시작 명령 확정 후, 영환님 승인으로 진행합니다. 이 문서에 plist 본문은 싣지 않습니다(진입점 미확정).

## 6. 롤백 (Serve 해제)

1. **[변경·승인 필요]** Serve 해제: `tailscale serve --https=443 off` 또는 전체 초기화 `tailscale serve reset`(문법 **확인 필요**).
2. **[변경·승인 필요]** Funnel이 켜져 있었다면: `tailscale funnel reset`.
3. **[조회·승인 필요]** `tailscale serve status`·`tailscale funnel status` 항목 0건 확인.
4. **[변경·승인 필요]** 상시 구동 중지(적용했다면): `launchctl bootout gui/$(id -u)/<label>`.
5. 앱 자체는 127.0.0.1에서 계속 돌아도 tailnet에서 닿지 않습니다. 2절 1번 스냅샷과 대조해 원래 상태인지 확인합니다.

## 7. 장애 시 확인 순서

다른 기기에서 접속이 안 될 때 위에서부터 확인합니다(모두 **[조회·승인 필요]**).

1. 맥이 켜져 있고 깨어 있는가(잠자기·로그아웃·전원).
2. 앱 프로세스가 살아 있는가: `lsof -nP -iTCP -sTCP:LISTEN | grep ':<port>'` → `127.0.0.1:<port>` 1줄.
3. 로컬 응답: `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/`.
4. Tailscale 연결: `tailscale status`(이 맥과 접속 기기가 online인지, 노드 키 만료 여부).
5. Serve 설정: `tailscale serve status`(대상이 `127.0.0.1:<port>`인지).
6. 접속 기기에서 `https://<tailnet-host>/` — 인증서 오류면 HTTPS 인증서 설정 확인(**확인 필요**).
7. 앱 로그인 실패면 Tailscale이 아니라 앱 인증 문제입니다(로그인 제한 S1, 비밀번호 복구는 `docs/runbooks/BOOTSTRAP_OWNER.md` 3절).
8. 점검 중 금지 사항(0절)이 하나라도 발견되면 원인 조사보다 6절 롤백이 먼저입니다.

## 8. 수동 증거

노출 경계 판정은 `qa/manual/QA-FR-OPS-01.md`(DEV_DESIGN §5-4 형식)에 기록합니다. 실행하지 않은 항목은 `PASS`로 적지 않습니다.
