# review-eval — 리뷰어 평가 세트

과거에 버그를 들여온 커밋(`bad_sha`)을 리뷰어(QA·Codex·Security)에게 다시 보여 주고, 기대 위치(`expected`)를 지적하는지 채점하기 위한 케이스 데이터다. 채점 실행기는 이 디렉터리 밖(Jarvis)에 있다. 리뷰 기준은 루트 `REVIEW.md`.

## 형식 (`cases.jsonl`, 한 줄 = 케이스 하나)
- `id` `ohs-NNN` · `kind` `fix|revert|negative` · `bad_sha`/`fix_sha` 전체 SHA(`fix_sha`는 negative면 `null`) · `layer` `review|qa|security|ci`.
- `expected[]`: `file`(bad_sha 시점 경로), `lines`[시작,끝](bad_sha 시점 줄 번호, bad_sha diff가 바꾼 줄 ±2 안), `severity` `P1|P2`, `reason`, `review_rule`(`REVIEW.md` 3절 번호 `3.N` 또는 `null`).
- `negative`: 이후 fix·revert가 그 줄을 고치지 않은 작은 커밋. `expected: []` — P1/P2 지적은 오탐.
- `source`: `<근거 SHA 7자>: <커밋 제목 인용 30자 이내>`.

## 케이스 추가 절차 (사고·revert 회고 → 케이스)
1. 회고에서 고친 커밋(fix/revert)을 정한다. revert는 "This reverts commit X"의 X가 `bad_sha`.
2. fix의 바뀐 줄을 `git blame --line-porcelain <fix>^ -L a,b -- <file>`로 추적해 `bad_sha`와 그 시점 줄 번호를 얻는다.
3. 포함 기준: bad_sha diff(1500줄 이하) + 당시 코드 + REVIEW.md만으로 지적 가능, 머지 커밋 아님.
4. 한 줄 추가 후 검증: JSON 파싱, `git cat-file -e`, `git merge-base --is-ancestor bad fix`, 파일·줄 범위·diff 포함 여부.
5. 같은 `bad_sha`는 케이스 하나로 합친다(여러 fix는 가장 이른 fix를 `fix_sha`로, 나머지는 `expected` 항목으로).

## 제외한 후보와 사유 (조사 범위: 최근 120일 fix·revert 203건 중 REVIEW.md 반복 유형 SHA + QA·보안 관련 제목)
- revert 커밋: 120일 안에 없음.
- `60313de` (삭제 통지에서 먼저 나간 멤버 누락): 원인이 `093a991`로 ohs-001과 같아 중복 — ohs-001에 흡수하지 않고 제외(판정 기준이 제품 결정에 가까움).
- `396a8ca` (채널 삭제 재연결 정합): 원인 `aa2bede`가 ohs-011과 같음 — 중복.
- `4365eac`·`7ed1d3a` (Dialog busy·BODY 포커스 트랩): 원인이 초기 Dialog 커밋 `6086308`의 "처리 누락"이라 diff에 지적할 줄이 없음.
- `4c1ccf6`·`dc605de` (나가기·다시 참여 뒤 포커스 BODY): blame이 3~4개 커밋에 흩어져 원인 커밋 특정 불가.
- `167553b` (폭 전환 시 첨부 칩 유실, QA r2): 원인이 `0a1cef9`·`3663656`·`9ba5fdd`에 분산 — 특정 불가.
- `364ccf7` (복원 세션 원격 로그아웃 안내, QA r2): 원인 `7b97a71`의 기능 누락이라 diff만으로 지적 근거 부족.
- hermes-plugin fix 다수(`08ef3c8`·`e3b40b9`·`f117df7` 등): 외부 런타임(Hermes·셸 환경) 의존 — 제외 기준 "외부 환경".
- 도구·CI 스크립트 fix(`d012938`·`762cbff`·`cf36bea`): 제품 불변식(REVIEW.md 3절) 밖, 원인 커밋 다수.
- negative 후보 `d5f91f7`: 이후 adapter.py fix 12건을 줄 단위로 다 확인하지 못해 제외.
- `76d3948`(1177줄)은 1500줄 이하라 포함(ohs-009). 그 밖에 1500줄 초과로 뺀 후보는 없음.

## 커버하는 유형
가시성·삭제(3.2) · 경계 import(3.11) · CSP(3.12) · 비동기 경합(3.13 ×3) · 업로드 권한 재확인(3.8 ×3) · 세션 판정 정규화 · 삭제 후 정리 누락. negative 3건(서버 타입·API 필드·디자인 토큰).
