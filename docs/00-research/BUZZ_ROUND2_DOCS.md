# ohmyslack — 2차 토론: 개발 문서 최종안 작성 + 상호 평가 (Buzz)

- 작성: Jarvis (2026-11-07) / 요청자: 영환님. 최종 채택은 영환님이 합니다.
- 진행: **R1 작성 → R2 상호 평가 → R3 반영·최종본.** 라운드마다 Jarvis가 같은 스레드에 시작 신호를 올립니다. 이번 메시지는 R1입니다.

## 0. 확정된 결정 (반박 대상 아님 — 2026-11-07 영환님 승인)

1. 방향 1: 클린룸 자체 서버 웹 메신저. Slack API·실시간 브리지 제외. P4 공식 export 1회 가져오기만 선택 후보.
2. 공개 범위: 개인 전용. 접속은 Tailscale tailnet(이 맥에 설치됨)으로 내 기기들만. 공인 인터넷 비노출.
3. 다기기 동기화: 서버(PostgreSQL) 원장 + 서버 저장 읽음 커서로 맥·다른 맥·휴대폰이 같은 대화·읽음 상태를 봄.
4. 배포: 웹앱 + PWA(홈 화면에 추가). 앱스토어 출시 없음. 모바일 반응형은 MVP(P0). 푸시·네이티브 앱은 v1 이후. Electron은 P3.
5. 이름 ohmyslack은 내부 코드명. REA의 Slack.app 분석은 종료(이후 우리 산출물 검증에만).
6. MVP = GPT-Sol안(단일 워크스페이스·초대·로그인·채널·1:1 DM·1단 스레드·수정/삭제·멘션·unread·실시간·재접속 복구) + 모바일 웹/PWA. 데이터·서버 = GPT-Luna안(PostgreSQL 단일 원장, 채널별 seq, client_message_id, 읽음 커서, Fastify 단일 HTTP/WS, Redis 미사용).

## 1. 현재 상태 (사실)

- 작업 폴더 `/Users/younghwankang/Work/ohmyslack` (git `main`). GitHub 비공개 저장소 `k002bill2/ohmyslack`에 올리며 진행합니다. **push는 Jarvis만** 라운드 종료마다 합니다(에이전트는 Git 작업 금지). 규칙: `CLEANROOM.md`.
- 공용 PostgreSQL에 DB `ohmyslack` + 전용 role `ohmyslack` 생성 완료(소유자, PUBLIC CONNECT 회수, image_maker와 상호 접근 불가 확인). 연결 문자열은 `~/Work/ohmyslack/.env`(600, git 무시) — **값을 읽거나 출력하지 마세요.**
- 입력 문서: `docs/01-synthesis/DISCUSSION_SYNTHESIS.md`(1차 토론 합본), `docs/_drafts/PRD-jarvis-v0.md`(Jarvis PRD 초안 — 요구사항 ID 체계 `FR-<AREA>-nn` 참고용), `docs/00-research/buzz/*.md`(1차 산출물).
- Node v26.12.1, pnpm 10.30.2 설치됨. Tailscale 설치됨.

## 2. R1 분장 — 문서 1개씩 (본인 파일만 작성)

| 담당 | 문서 | 경로 | 반드시 포함 |
|---|---|---|---|
| **GPT-Sol** | PRD | `docs/02-prd/PRD.md` | 정의·목표/비목표·원칙·사용자·시나리오(S1–S6, S6=다기기)·FR 표(`\| FR-XXX-nn \| 요구사항 \| P0/P1/P2 \| 수용 기준 \| 출처 \|` 형식 유지)·명시적 제외·지표·계측(PII 없음)·⚖️·변경 이력. Jarvis 초안을 출발점으로 수정·보강 |
| **GPT-Luna** | TRD | `docs/03-trd/TRD.md` | 시스템 구성도(텍스트), 스택·버전 고정 원칙, 데이터 모델(DDL 수준), API·WS 이벤트 계약, 동기화·재접속·멱등 계약, 인증·세션·CSRF·WS 인증, Tailscale Serve 노출 방식, PWA(manifest·SW 캐시 범위), 보안 `TR-SEC-nn`, NFR, 마이그레이션·백업, ⚖️ |
| **Claude-Opus 5.5** | 개발설계서 | `docs/04-dev-design/DEV_DESIGN.md` | 모노레포 구조(`apps/web`·`apps/server`·`packages/shared` 등), 모듈 경계, 단계(P0–P4)·종료 게이트, WBS(담당 역할·선행·완료 조건), **테스트 전략(TDD): PRD의 모든 P0 FR ID → 테스트 이름 1:1 매핑 표**, 품질 게이트·CI 명령, 위험. Hermes 실행 역할은 Developer·Designer·QA·Security(Orca) 기준 |
| **Claude-Fable** | 디자인 레퍼런스 | `docs/05-design-ref/DESIGN_REFERENCE.md` | 클린룸 디자인 원칙(Slack 룩앤필·색·소리·아이콘·폰트 불사용), 오픈 출처 토큰(폰트·아이콘 세트·색 체계 — 라이선스 명시), 정보 구조·3단/모바일 1단 레이아웃, 컴포넌트 목록과 상태(빈·로딩·오류·전송 상태·오프라인), 접근성·키보드·한글 IME, 반응형 브레이크포인트, PWA 아이콘 원칙 |

- 다른 담당 문서와 맞물리는 부분(FR ID, 테이블명, 이벤트명, 컴포넌트명)은 **가정으로 명시**하고 R3에서 맞춥니다. 먼저 끝난 사람의 파일이 있으면 읽고 맞춰도 됩니다.
- 각 문서 첫머리에 `상태: R1 초안 / 작성자 / 입력`을 적습니다.

## 3. R2(예고) — 상호 평가

R1 4개 파일이 모두 생기면 Jarvis가 신호를 올립니다. 각자 **다른 3개 문서**를 평가해 `docs/06-reviews/<본인>.md`에 씁니다.
- 문서별: 점수(1–5: 정확성·완결성·문서 간 정합성·구현 가능성), Must-fix(번호·근거 file:line), Should-fix, 동의하는 강점 1–2개.
- 문서 간 충돌 목록(ID·이름·계약 불일치).

## 4. R3(예고) — 반영·최종본

각 저자는 받은 Must-fix를 모두 처리(반영 또는 근거 있는 거절)하고 문서 끝에 `리뷰 반영 기록` 표를 붙인 뒤 상태를 `R3 최종안`으로 바꿉니다.

## 5. 공통 규칙

- 형식: 한국어 존댓말, 사실/추정/확인 필요 구분, 외부 링크는 공식 문서만(robots.txt·약관 먼저 확인).
- 쓰기 범위: **본인 담당 파일만.** 코드 작성·패키지 설치·Git 작업·DB 접속·`.env` 열람·shared-infra 수정 금지. Slack 웹앱·Slack.app 접근 금지.
- 완료 시 이 스레드에 답글 1건: 요약 3줄 + 파일 경로.
