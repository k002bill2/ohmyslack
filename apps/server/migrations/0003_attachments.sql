-- 0003 첨부 메타데이터·바이트. 정본: docs/03-trd/TRD.md §2 `attachments`·`attachment_blobs` 행·필수 인덱스, §6-1(R3.3, ADR-001).
-- 스키마 중립: 이름을 스키마로 한정하지 않는다(실행기가 search_path의 스키마에 적용). 트랜잭션은 실행기가 연다.
-- 바이트는 attachment_blobs에 분리 저장한다(목록·projection 조회가 bytea를 읽지 않게, B10).

CREATE TABLE attachments (
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  uploader_id uuid NOT NULL,
  message_id uuid,
  mime text NOT NULL,
  byte_size integer NOT NULL,
  sha256 text NOT NULL,
  duration_ms integer,
  width integer,
  height integer,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CONSTRAINT attachments_pkey PRIMARY KEY (id),
  CONSTRAINT attachments_mime_check CHECK (mime IN ('audio/mpeg', 'image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT attachments_byte_size_check CHECK (byte_size BETWEEN 1 AND 10485760),
  CONSTRAINT attachments_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE RESTRICT,
  CONSTRAINT attachments_uploader_id_fkey FOREIGN KEY (uploader_id) REFERENCES users (id) ON DELETE RESTRICT,
  -- 결속은 같은 대화의 메시지에만(복합 FK). message_id가 NULL이면(미결속) 검사하지 않는다(MATCH SIMPLE).
  CONSTRAINT attachments_message_fkey FOREIGN KEY (conversation_id, message_id)
    REFERENCES messages (conversation_id, id) ON DELETE RESTRICT
);

CREATE INDEX attachments_message_id_idx ON attachments (message_id);
CREATE INDEX attachments_expires_at_live_idx ON attachments (expires_at) WHERE deleted_at IS NULL;

CREATE TABLE attachment_blobs (
  attachment_id uuid NOT NULL,
  bytes bytea NOT NULL,
  CONSTRAINT attachment_blobs_pkey PRIMARY KEY (attachment_id),
  CONSTRAINT attachment_blobs_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES attachments (id) ON DELETE CASCADE
);
