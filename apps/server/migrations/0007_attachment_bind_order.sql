-- 0007 첨부 표시 순서. 정본: docs/03-trd/TRD.md §2 `attachments` 행·§6-1 결속(R3.7, DEV_DESIGN W-31).
-- 스키마 중립: 이름을 스키마로 한정하지 않는다(실행기가 search_path의 스키마에 적용). 트랜잭션은 실행기가 연다.
-- 결속 때 요청 `attachment_ids`에서의 0부터 위치를 기록한다. 열 추가만 하며 0007 이전에 결속된 행은 NULL로 둔다(백필 없음).

ALTER TABLE attachments
  ADD COLUMN bind_order smallint,
  ADD CONSTRAINT attachments_bind_order_check CHECK (bind_order IS NULL OR bind_order >= 0);
