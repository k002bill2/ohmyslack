# ohmyslack — 2차 토론 R3: 리뷰 반영·최종본 (Buzz)

- 작성: Jarvis (2026-11-07). 최종 채택은 영환님이 합니다.
- 입력: R1 문서 4개, R2 리뷰 `docs/06-reviews/{GPT-Sol,GPT-Luna,Claude-Opus,Claude-Fable}.md` (4/4 수신, 커밋 반영)

## 1. 할 일 (저자별, 본인 문서만 수정)

| 저자 | 문서 | 처리할 리뷰 |
|---|---|---|
| GPT-Sol | `docs/02-prd/PRD.md` | GPT-Luna·Claude-Opus·Claude-Fable 리뷰의 PRD 항목 |
| GPT-Luna | `docs/03-trd/TRD.md` | GPT-Sol·Claude-Opus·Claude-Fable 리뷰의 TRD 항목 |
| Claude-Opus 5.5 | `docs/04-dev-design/DEV_DESIGN.md` | GPT-Sol·GPT-Luna·Claude-Fable 리뷰의 개발설계서 항목 |
| Claude-Fable | `docs/05-design-ref/DESIGN_REFERENCE.md` | GPT-Sol·GPT-Luna·Claude-Opus 리뷰의 디자인 레퍼런스 항목 |

1. 받은 **Must-fix는 전부** 처리합니다: 반영하거나, 근거(file:line)를 들어 거절합니다. Should-fix는 선택.
2. 문서 끝에 `## 리뷰 반영 기록` 표를 붙입니다: `| 리뷰어 | 항목 ID | 처리(반영/거절/부분) | 변경 위치 file:line 또는 거절 근거 |`.
3. 첫머리 상태를 `R3 최종안`으로 바꿉니다.
4. GPT-Luna는 본인 리뷰 파일 `docs/06-reviews/GPT-Luna.md` 맨 앞에 다른 리뷰와 같은 형식의 **점수 요약 표**(문서별 정확성·완결성·정합성·구현 가능성 1–5)를 추가해 주세요. R2 파일에 점수가 빠져 있습니다.

## 2. 문서 간 충돌의 정본 (핑퐁 방지)

충돌이 있으면 아래 정본 문서를 기준으로 **다른 문서가 맞춥니다.** 정본 저자는 R3에서 값을 확정하고, 다른 저자는 정본 값을 그대로 인용합니다.

| 대상 | 정본 |
|---|---|
| FR ID·우선순위·수용 기준·시나리오 | PRD |
| 테이블·컬럼·API 경로·WS 이벤트명·커서/seq 계약·인증·보안 TR-SEC | TRD |
| 저장소 구조·단계 게이트·WBS·FR→테스트 매핑·CI 명령·테스트 DB | 개발설계서 |
| 디자인 토큰·브레이크포인트·레이아웃 폭·컴포넌트명·상태 문구·키맵·IME 규칙 | 디자인 레퍼런스 |

- 정본 저자가 아닌 쪽은 값을 새로 정하지 말고 "정본: <문서> §절" 인용으로 바꿉니다.
- 정본 저자끼리 의견이 갈리면 각자 문서에 `⚖️ 미정합 — <상대 문서 file:line>`으로 남기고 Jarvis가 정리합니다(교차 수정 금지).

## 3. 공통 규칙

- 브리프 2차 0절 확정 결정은 반박 대상이 아닙니다(방향 1, 개인 전용+Tailscale, 서버 원장 다기기 동기화, 웹+PWA·출시 없음, Redis 미사용).
- 쓰기 범위: 본인 문서(+GPT-Luna는 본인 리뷰 파일)만. 코드·설치·Git·DB 접속·`.env` 열람·shared-infra 수정 금지.
- 완료 시 같은 스레드에 답글 1건: Must-fix 처리 수(반영/거절) + 남은 ⚖️ + 경로.
