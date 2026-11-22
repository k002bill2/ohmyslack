-- 0008 채널 삭제(FR-CONV-06). 정본: docs/03-trd/TRD.md §3 `DELETE /api/conversations/{id}`.
-- 스키마 중립: 이름을 스키마로 한정하지 않는다(실행기가 search_path의 스키마에 적용). 트랜잭션은 실행기가 연다.
-- 소프트 삭제: 메시지·첨부·멤버 행은 물리 삭제하지 않는다(물리 정리는 범위 밖).
-- 삭제 트랜잭션은 그 채널의 활성 멤버 행 전원(사람·봇)에 left_at = 삭제 시각을 기록한다(멤버십 종료, 행은 유지).
-- 롤백 주의: 삭제된 채널 이름을 새 채널이 재사용한 뒤에는 0008 이전 바이너리·전체 유니크 인덱스로 되돌릴 수 없다(인덱스 재생성 실패).
-- 배포 순서: 새 서버를 올리기 전에 이 마이그레이션을 먼저 적용한다(새 조회 SQL이 deleted_at을 항상 참조한다).
ALTER TABLE conversations
  ADD COLUMN deleted_at timestamptz NULL,
  ADD COLUMN deleted_by uuid NULL REFERENCES users (id) ON DELETE RESTRICT,
  ADD CONSTRAINT conversations_deletion_check CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL)
    OR (kind = 'channel' AND deleted_at IS NOT NULL AND deleted_by IS NOT NULL));

-- 이름 재사용 허용: 삭제된 채널은 이름 유일성에서 뺀다.
DROP INDEX conversations_channel_name_norm_key;
CREATE UNIQUE INDEX conversations_channel_name_norm_key ON conversations (workspace_id, name_norm)
  WHERE kind = 'channel' AND deleted_at IS NULL;
