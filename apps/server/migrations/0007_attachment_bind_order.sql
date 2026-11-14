-- 0007 첨부 표시 순서. 정본: docs/03-trd/TRD.md §2 `attachments` 행·§6-1 결속(R3.7, DEV_DESIGN W-31).
-- 스키마 중립: 이름을 스키마로 한정하지 않는다(실행기가 search_path의 스키마에 적용). 트랜잭션은 실행기가 연다.
-- 결속 때 요청 `attachment_ids`에서의 0부터 위치를 기록한다. 열 추가만 하며 0007 이전에 결속된 행은 NULL로 둔다(백필 없음).
-- 배포 순서: 새 서버를 올리기 전에 이 마이그레이션을 먼저 적용한다(새 조회 SQL이 이 열을 항상 참조한다).
-- 앱을 되돌릴 때 이 열과 마이그레이션 기록은 그대로 둔다(옛 코드는 이 열을 쓰지 않는다).

ALTER TABLE attachments ADD COLUMN bind_order smallint;
