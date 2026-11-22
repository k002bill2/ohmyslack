# REVIEW.md — ohmyslack AI 리뷰 기준

## 1. 목적·적용 대상
- 읽는 쪽: Orca QA(tier Q)·Codex 교차 검토(tier X)·Security 리뷰 레인, 로컬 `/code-review`. 리뷰를 시작하기 **전에** 읽는다.
- 이 파일은 "무엇을 지적하고 무엇을 넘길지, 어떤 형식으로 쓸지"만 정한다. 작업 방법·명령은 `CLAUDE.md`가 정본이며 여기에 복제하지 않는다.

## 2. 의도 먼저
1. 레인 브리프(목적·수용 기준) 또는 PR 본문을 먼저 읽고, diff가 그 의도와 맞는지부터 판단한다.
2. 의도 밖 변경(범위 초과: 인접 코드 정리, 무관한 파일)은 그 자체로 지적 대상이다(`P2`).
3. 기능 추가 커밋/PR 본문에 `참고 출처:` 줄이 없으면 지적한다(`P2`). 근거: `CLEANROOM.md` §4.

## 3. 반드시 지적 (이 저장소 불변식)
각 항목은 한 줄 규칙 + 근거다. 위반이 확인되면 기본 `P1`이다.

1. **대화 단위 접근 판정은 `conversations.service.assertAccess` 하나로만.** 라우트·WS 처리기에서 멤버십을 직접 조회하거나 `access` 메타를 빠뜨리면 지적.
   - 근거: `docs/04-dev-design/DEV_DESIGN.md` §2-2 B2·§2-4, 재현 `apps/server/test/conversations/access-matrix.int.test.ts`, `apps/server/src/http/access.ts`. 다른 모듈의 `repo`를 직접 import하는 것도 같은 우회 경로로 본다(service만 호출): `docs/04-dev-design/DEV_DESIGN.md` §2-2 B1, `tools/test/eslint-boundaries.test.ts`.
2. **비참여자에게 대화의 존재를 드러내지 않는다.** 비멤버 404(403 아님), 삭제·나간 대화는 없는 대화와 같게 응답.
   - 근거: `docs/03-trd/TRD.md` §5 TR-SEC-01, `docs/02-prd/PRD.md` FR-CONV-04·FR-CONV-06, 재현 `apps/server/test/conversations/channel-delete.int.test.ts`.
   - 반복 유형: 채널 삭제 후 멤버십·구독·통지 누락 `4ebe991` `60313de` `396a8ca`.
3. **WS 이벤트는 DB 커밋 후에만, 진실의 원천은 DB.** 커밋 전 팬아웃, WS에만 있는 상태, catch-up 없이 checkpoint 전진(watermark 도달 전)을 지적.
   - 근거: `docs/04-dev-design/DEV_DESIGN.md` §2-2 B3·B4·§2-3, `docs/03-trd/TRD.md` §4, 재현 `apps/server/test/sync/sync.int.test.ts`.
4. **메시지 전송 멱등성·읽음 병합.** 같은 `client_message_id`+같은 payload=원결과, 다른 payload=409, 읽음은 `max`로만 갱신.
   - 근거: `docs/04-dev-design/DEV_DESIGN.md` §2-3, 재현 `apps/server/test/messages/idempotency.int.test.ts`, `apps/server/test/sync/read-merge.int.test.ts`.
5. **로그는 `ops` 로거만, 본문·토큰·쿠키·ID·파일명 금지.** `console.*`·직접 직렬화로 새는 경로를 지적.
   - 근거: `docs/04-dev-design/DEV_DESIGN.md` §2-2 B6, `tools/check-log-leak.ts`, 재현 `apps/server/test/ops/log-redaction.int.test.ts`.
6. **웹은 대화 본문·인증 응답을 브라우저 저장소에 넣지 않는다**(예외는 B7의 두 파일뿐).
   - 근거: `docs/04-dev-design/DEV_DESIGN.md` §2-2 B7, `docs/03-trd/TRD.md` TR-SEC-08, `tools/check-no-persist-cache.ts`.
7. **API·WS 계약은 `packages/shared` zod 스키마가 단일 정의.** 서버·웹에 같은 필드를 손으로 중복 정의하거나 경계 밖에서 snake/camel 변환하면 지적.
   - 근거: `docs/04-dev-design/DEV_DESIGN.md` §2-2 B5, `docs/03-trd/TRD.md` §3–4.
8. **첨부·업로드 경로의 권한·상한은 본문 수신 전에, 저장 트랜잭션 안에서 재확인.** 인증 전 대용량 수신, 업로드 중 권한 상실 미반영, 미결속 첨부의 업로더 외 읽기를 지적.
   - 근거: `docs/08-security/SECURITY_REVIEW_P1.md` 부록 SR-D-01·SR-D-04, `docs/03-trd/TRD.md` §6-1, 재현 `apps/server/test/attachments/bot-upload-early.int.test.ts`, `apps/server/test/attachments/bot-upload-recheck.int.test.ts`.
   - 반복 유형 `e90ccbf` `fe82c2d` `59e9c4a` `c53425a`.
9. **첨부 바이트·형식 판정은 `attachments` 모듈 안에서만, 다운로드 헤더 고정**(`no-store`·`nosniff`·`sandbox` CSP). 서버에서 압축 해제·XML 파싱·변환 금지.
   - 근거: `docs/04-dev-design/DEV_DESIGN.md` §2-2 B10, `docs/03-trd/TRD.md` §6-1·§6-1-1, 재현 `apps/server/test/attachments/attachment-headers.int.test.ts`.
10. **서버는 `127.0.0.1`에만 바인드, 봇 리스너는 `/api/bot/v1/**`만.** 메인 리스너가 `Authorization` 헤더를 읽거나 봇 토큰으로 사람 API가 열리면 지적.
   - 근거: `docs/04-dev-design/DEV_DESIGN.md` §2-2 B9·§8, `docs/03-trd/TRD.md` TR-SEC-07, 재현 `apps/server/test/bots/bot-listener-bind.int.test.ts`, `apps/server/test/ops/bind.int.test.ts`.
11. **웹 기능 폴더 간 import는 `index.ts` 공개 API로만, 화면 데이터는 `apps/web/src/data/` 주입 경계로.** 다른 기능의 내부 파일을 직접 import하면 지적.
   - 근거: `docs/04-dev-design/DEV_DESIGN.md` §2-2 B8, `tools/test/eslint-boundaries.test.ts`.
   - 반복 유형 `e0dbb95`.
12. **CSP `style-src 'self'`·`img-src 'self' data:` 준수.** 인라인 style·외부 이미지 출처 도입을 지적.
   - 근거: `docs/03-trd/TRD.md` §5-1 S6, `apps/server/src/http/security.ts`.
   - 반복 유형 `e9d03ec`.
13. **비동기 응답 경합: 늦게 도착한 오래된 응답이 새 상태를 덮어쓰지 않는다.** 요청 순번·컨트롤러 가드 없는 목록·칩·재시도 갱신을 지적(재현 조건 필수).
   - 근거: `docs/03-trd/TRD.md` §4(change_id 적용 키·중복 제거), 재현 `apps/web/test/sync/http-source-list-order.test.ts`.
   - 반복 유형 `f56051a` `4b56584` `fe84f07`.
14. **Dialog·화면 전환 뒤 포커스가 BODY로 빠지지 않고, Esc·Tab 트랩·busy 중 닫기 잠금이 유지된다.**
   - 근거: `docs/07-ui-spec/UI_STATES.md` §2-8·§4-2, 재현 `apps/web/test/a11y/labels.test.tsx`.
   - 반복 유형 `4c1ccf6` `dc605de` `4365eac` `7ed1d3a`.
15. **클린룸.** 외부 제품의 코드·에셋·색·폰트·사운드 도입, 허용되지 않은 디자인 토큰 출처를 지적. 금지 문자열 목록은 여기에 복제하지 않고 `CLEANROOM.md` §3·§5와 `tools/check-cleanroom.ts`를 따른다. 토큰 출처: `docs/05-design-ref/DESIGN_REFERENCE.md` §3.

## 4. 지적하지 않음
- 린터·`tsc`·포매터·`pnpm verify`의 `check:*`가 이미 잡는 것(한 번 더 말하지 않는다).
- 취향성 네이밍·주석 스타일·코드 모양 선호.
- 생성물·lockfile·스냅샷·빌드 산출물.
- 브리프 범위 밖 기존 코드의 개선 제안 — 별건 메모 한 줄로만(지적 수에 넣지 않음).
- 수동 QA 문서(`qa/manual/QA-*.md`)의 서식. 단, 실행 없이 PASS 표시한 것은 지적한다(근거: `docs/04-dev-design/DEV_DESIGN.md` §8 8번).

## 5. 리뷰 제외 경로
- `pnpm-lock.yaml`
- `**/dist/**`, `**/coverage/**`, `**/reports/**`, `**/node_modules/**`
- `docs/00-research/**`, `docs/01-synthesis/**`, `docs/06-reviews/**` (토론·리뷰 원문 기록)
- `apps/server/test/attachments/fixtures/**` (테스트 입력 데이터)
- `dev/**` (작업 기록, git 추적 대상 아님)

## 6. 지적 형식
- 심각도
  - `P1` 병합 차단: 데이터 손실·보안·불변식(3번) 위반·사용자 흐름 파손.
  - `P2` 병합 전 수정 권장.
  - `P3` 선택.
- 각 지적은 네 가지를 모두 쓴다: ① `파일:라인` ② 발생 조건(어떤 입력·상태에서 깨지는지) ③ 근거(규칙 문서 경로·섹션 또는 재현 테스트) ④ 최소 수정안.
- "이름이 위험해 보인다" 같은 추측성 지적 금지. 재현 조건을 대지 못하면 `확인 필요`로 표기하고 `P1`로 올리지 않는다.
- 아무것도 지적할 것이 없으면 "지적 없음"과 확인한 범위(읽은 파일·실행한 명령)를 적는다.

## 7. 상한·반복 방지
- `P3`는 리뷰당 최대 3개.
- 재리뷰(2회차 이후)는 새 diff에 집중한다. 이미 남긴 지적은 반복하지 않고 해결 여부(`해결`/`미해결`)만 표시한다.

## 8. 지적 처리 기록
리뷰를 받은 쪽(Jarvis/Developer)은 지적마다 다음 중 하나와 한 줄 사유를 남긴다. 이 기록은 이후 리뷰어 평가 세트로 쓴다.
- `반영` — 수정함(커밋 SHA).
- `오탐` — 틀린 지적(재현이 안 되는 이유).
- `의도된 동작` — 브리프·문서가 요구한 동작(근거 경로).

## 9. 유지보수
- 같은 지적이 2회 이상 반복되면 3번에 규칙으로 올린다(근거 문서·SHA 필수, 근거 없는 규칙은 추가하지 않는다).
- 기계적으로 잡을 수 있으면 린트·테스트·`check:*` 스크립트로 옮기고, 이 파일에는 링크만 남긴다.
- 3번의 `근거:` 경로가 사라지거나 이동하면 같은 PR에서 이 파일을 고친다.
