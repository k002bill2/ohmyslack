# R3 재개 handoff (2026-11-07)

## 목적·승인 범위

영환님 요청: Buzz 토론방 에이전트들이 PRD·TRD·개발설계서·디자인 레퍼런스 최종안을 직접 쓰고 서로 평가. 자료는 `/Users/younghwankang/Work/ohmyslack`, 비공개 GitHub `k002bill2/ohmyslack`에 업로드하면서 진행. 영환님은 취침하며 추천안 자동 진행 승인. 코드 구현·공개 배포는 이번 복구 범위 밖. 문서 본문은 Jarvis가 대필하지 않음.

## 현 상태

- `docs/06-reviews/R3_COLLECTION_STATUS.md` 확인. PRD·TRD R3 완료(실질 Buzz 답글도 화면 확인), 개발설계서·디자인은 R1. Claude 구독 5시간 한도 오류, 공급자 메시지 reset=07:00 KST. 공급자 한도 소진은 재시작·유료 API 전환으로 우회하지 않음.
- 진행 단계: R1 작성 완료 → R2 동료 3명씩 평가 완료 → R3 리뷰 반영 중(2/4).
- 재개 대상: Claude-Opus 5.5 → `docs/04-dev-design/DEV_DESIGN.md`; Claude-Fable → `docs/05-design-ref/DESIGN_REFERENCE.md`. 두 저자의 역할은 바꾸지 않음.
- 원래 분장: `docs/00-research/BUZZ_ROUND3_FINAL.md`. 정본은 PRD=요구사항, TRD=스키마/API/WS/동기화, 개발설계서=WBS/테스트, 디자인=토큰/레이아웃/상태/IME.
- 같은 Buzz #general의 ohmyslack 스레드. 원 글은 02:14 AM 영환님 글, 첫 문장 `ohmyslack 토론 요청: 지금 쓰는 Slack을 REA로 분석해 ohmyslack으로 구현하는 안의 구현 가능성과 구현해야 할 범위(MVP)를 토론해 주세요.`

## 재요청 문안 (한 게시물, 같은 스레드)

Claude-Opus 5.5, Claude-Fable 두 분에게만 R3 미완료 작업을 다시 요청합니다. GPT-Sol과 GPT-Luna는 재작업하지 마세요. Claude 5시간 한도(reset 07:00)로 앞선 요청이 실패했습니다. 기존 결과는 보존합니다. 브리프 `/Users/younghwankang/Work/ohmyslack/docs/00-research/BUZZ_ROUND3_FINAL.md`를 읽고, 현재 R3 PRD와 TRD를 기준으로 본인 문서만 최종화해 주세요. Opus는 `docs/04-dev-design/DEV_DESIGN.md`, Fable은 `docs/05-design-ref/DESIGN_REFERENCE.md`를 수정합니다. 받은 Must-fix를 전부 반영 또는 근거 있게 거절하고, `리뷰 반영 기록` 표와 `R3 최종안` 상태를 남기며, 같은 스레드에 처리 건수와 남은 미정합·파일 경로를 답글로 남겨 주세요. 코드·Git·설치·DB·.env·shared-infra 수정은 금지합니다. 여전히 한도 오류면 반복 호출 없이 오류를 보고해 주세요.

## 실행·검증 경로

1. 첫 도구 호출은 Jarvis AGENTS.md 읽기. buzz-agent-operations 스킬 및 desktop-composer-and-delivery-evidence 참고. 최신 로스터 확인 후 시작.
2. 먼저 파일과 현재 화면을 확인: 이미 R3를 받았다면 중복 재요청하지 않고 회수/검증 단계로 진행. 수신되지 않은 저자만 요청.
3. Jarvis는 자신의 Buzz CLI 키 없음. **다른 ACP 프로세스의 자격증명을 가져오지 말 것.** 데스크톱 UI로 게시.
4. Hermes `computer_use`는 MCP 연결 실패라 cua-driver CLI 사용. `~/.local/bin/cua-driver call <tool> '<JSON>'`. `list_windows`로 최신 Buzz pid/window 재식별(이전 pid 1280, window 75는 재확인 필요).
5. 읽기 전용 `get_window_state`에 `session` 새 라벨, `screenshot_out_file`, `timeout_ms:8000`, `max_elements:2000`. 기본 1초 AX는 큰 스레드에서 composer까지 못 읽음.
6. 화면 입력은 별도 사용자 입력이 보이면 중지. 영환님 취침 자동진행 승인에는 이 문서 게시의 전경 조작·클립보드 백업/복원 포함. 개인 창은 건드리지 말 것.
7. 표시가 꺼져 AXWindow 0·붙여넣기 무반영이면 반복 입력 금지. `open -a /Applications/Buzz.app`로 창 재오픈(앱 재시작 아님), 필요시 짧은 `caffeinate -d -u -t 120`으로 화면 깨운 뒤 전경과 최신 캡처 확인.
8. 스레드 composer에는 네 에이전트 자동 멘션 칩이 이미 있음. 비대상 칩 제거는 fresh AX 토큰으로 하되 오류면 기존 칩을 유지하고 본문에서 Sol/Luna는 작업 없음 명시. 관련 없는 새 대화 만들지 않음.
9. 본문 파일을 scratch에 작성하고 pbpaste 내용을 메모리에 백업→pbcopy 본문→Buzz composer foreground 클릭→hotkey cmd+v→fresh capture의 AXTextArea 전문 대조+vision→클립보드 복원·해시 확인. 입력 불확실한 재시도는 중단.
10. Send message AX 토큰이 `element_outside_target_window`면 같은 최신 캡처 `screenshot_frame` 중심 좌표와 `capture_id`로 foreground 클릭. 게시 후 단일 본문+칩+빈 composer를 vision으로 확인. 본문이 남았으면 게시 완료 아님.
11. 게시 성공 후 약 45분 뒤 한 번의 회수용 cron을 잡아 문서 4개·리뷰 4개 전문 대조, Must-fix 처리 누락·PRD P0 33개 테스트 매핑·정본 계약을 검증. timeout이면 부분 완료 보고. cron은 짧은 실행 예산이므로 긴 감시를 동기로 돌리지 않음.
12. 수신 파일만 명시 경로로 add·commit·push(승인된 비공개 ohmyslack 원격만). `.env`/shared-infra 변경 push는 불가. R3 완료 표시만으로 독립 PASS라고 보고하지 말 것.

## 최종 보고 목적지

Slack `slack:C0C96RAA74N:1793982097.306219`. 한국어 존댓말, 최종 문서·Git·검증·미정합·구현 미착수 분리. Newton 미경유(영환님 Buzz 지정). 권한·유료 결제·공개 노출 등 범위 확장 금지.
