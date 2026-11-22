-- 0008 채널 삭제(FR-CONV-06). 정본: docs/03-trd/TRD.md §3 `DELETE /api/conversations/{id}`.
-- 스키마 중립: 이름을 스키마로 한정하지 않는다(실행기가 search_path의 스키마에 적용). 트랜잭션은 실행기가 연다.
-- 소프트 삭제: 메시지·첨부·멤버 행은 물리 삭제하지 않는다(물리 정리는 범위 밖).
-- 배포 순서: 새 서버를 올리기 전에 이 마이그레이션을 먼저 적용한다(새 조회 SQL이 deleted_at을 항상 참조한다).
ALTER TABLE conversations
  ADD COLUMN deleted_at timestamptz NULL,
  ADD COLUMN deleted_by uuid NULL REFERENCES users (id);

-- 이름 재사용 허용: 삭제된 채널은 이름 유일성에서 뺀다.
DROP INDEX conversations_channel_name_norm_key;
CREATE UNIQUE INDEX conversations_channel_name_norm_key ON conversations (workspace_id, name_norm)
  WHERE kind = 'channel' AND deleted_at IS NULL;
