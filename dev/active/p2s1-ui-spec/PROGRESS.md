# PROGRESS — p2s1-ui-spec

- [x] 입력 정본 읽기 (ADR-002 §3·§4, UI_STATES, COPY_GAPS, DESIGN_REFERENCE, PRD FR, Claude-Fable §5)
- [x] 서브에이전트 ① 첨부·작성기·CSS 토큰 조사
- [x] 서브에이전트 ② 세션 라우트·`GET /api/sessions`·Dialog busy 조사
- [x] UI_STATES.md — 문서 첨부 CMP 추가
- [x] UI_STATES.md — CMP-22 SessionList 구체화
- [x] COPY_GAPS.md — 새 문구
- [x] DESIGN_REFERENCE.md — 문서 행·세션 목록 토큰·간격·포커스·44px
- [x] 표 열 수 일치 확인
- [x] `pnpm check:cleanroom`·`pnpm check:design-tokens` EXIT 0 (logs/)
- [x] REPORT.md (UI-D·UI-AC·재QA·PRD/TRD 제안·iPhone 실기)
- [x] 커밋 1–3개, diff 범위 확인

## 서브에이전트 결과
- ① 첨부·토큰(Explore, 읽기 전용): 완료. W-22 이미지 업로드·`ATTACHMENT_COPY`(copy.ts:331-347) 존재, 업로드는 20초 상한 면제·fetch(진행 이벤트 없음), 토큰 tokens.ts, 44px는 토큰 아님.
- ② 세션·Dialog(Explore, 읽기 전용): 완료. `GET /api/sessions`(id·created_at·last_seen_at·expires_at·current)만, 기기 라벨·revoke 라우트 없음, `/settings` 라우트 없음, Dialog busy 규칙 Dialog.tsx:10-201.
