# QA-FR-OPS-01 — tailnet 전용 노출 경계 (DEV_DESIGN 6-2 FR-OPS-01, 5-4 형식)

> 템플릿입니다. 아직 실행하지 않았습니다. 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).
> 모든 점검 명령은 **[조회·승인 필요]**입니다 — 영환님 승인 후 실행합니다. 설정 변경은 이 QA 범위가 아닙니다(`docs/runbooks/TAILSCALE_SERVE.md`).
> 증거에 실제 tailnet 호스트명·IP·비밀 값을 남기지 않습니다. `<tailnet-host>`·`<port>`처럼 가려서 기록합니다.

| 필드 | 값 |
|---|---|
| 실행자 | (미실행 — 실행 시 이름 기입) |
| 일시(KST) | (미실행 — YYYY-MM-DD HH:MM KST) |
| 기기·OS·브라우저(버전) | (미실행 — 예: 서버 Mac / macOS 버전 · tailnet 기기 iPhone / iOS·Safari 버전 · tailnet 밖 기기 / OS·브라우저 버전) |
| 접속 경로 | localhost(서버 Mac, `127.0.0.1:<port>`) / tailnet Serve HTTPS(`https://<tailnet-host>`) / tailnet 밖·LAN 직접 접근(실패 기대) |
| 절차 | 아래 "점검 절차" 1–7번 |
| 기대 결과 | ① 앱 리스너가 `127.0.0.1:<port>` 하나뿐 ② PG 리스너가 `127.0.0.1:5432`뿐 ③ Funnel 항목 0건 ④ Serve 대상이 `127.0.0.1:<port>` 하나뿐, 5432 없음 ⑤ tailnet 밖 기기·LAN 직접 접근 실패 ⑥ tailnet 기기 Serve HTTPS 접근은 로그인 화면(로그인 생략 없음) ⑦ ACL·공유 노드 점검 기대 충족 |
| 실제 결과 | (미실행) |
| 판정 | `미검증` |
| 증거 경로 | (미실행 — 명령 출력·스크린샷 저장 경로 기입. 자동 증거: `apps/server/test/ops/bind.int.test.ts`(작성 시점 미존재, 예정)) |

## 점검 절차

| # | 점검 | 명령·방법 [조회·승인 필요] | 기대 | 실제 |
|---|---|---|---|---|
| 1 | 리스너 loopback 한정 | 서버 Mac: `lsof -nP -iTCP -sTCP:LISTEN` | 앱 `127.0.0.1:<port>`만. `*:`·`0.0.0.0:`·`[::]:`·LAN IP 리스너로 앱 포트가 보이지 않음 | (미실행) |
| 2 | PG 바인드 | 같은 출력에서 `:5432` 줄 (보조: `docker port <pg 컨테이너>`) | `127.0.0.1:5432`만(TRD §5-1 S13) | (미실행) |
| 3 | Funnel off | `tailscale funnel status` | 공개 항목 0건 | (미실행) |
| 4 | Serve 대상 | `tailscale serve status` | `https://<tailnet-host>` → `http://127.0.0.1:<port>` 1건. 5432·기타 포트 대상 없음 | (미실행) |
| 5 | tailnet 밖·LAN 접근 실패 | tailnet에 없는 기기(같은 LAN)에서 `http://<맥 LAN IP>:<port>/`·`http://<맥 LAN IP>:5432`, 그리고 tailnet 밖 기기에서 `https://<tailnet-host>/` 접속 시도 | 모두 연결 실패(거부·시간 초과·이름 해석 실패). 응답 본문 0 | (미실행) |
| 6 | tailnet 기기 접근·로그인 유지 | tailnet 기기 브라우저로 `https://<tailnet-host>/` | HTTPS로 열리고 로그인 화면 표시. tailnet 접근만으로 로그인 생략 안 됨 | (미실행) |
| 7 | ACL·공유 노드 | 런북 4절 A1–A6 | 본인 기기·계정만, 외부 공유 0건 | (미실행) |

하나라도 기대와 다르면 판정 `FAIL`, 런북 6절 롤백을 먼저 하고 원인을 기록합니다.
