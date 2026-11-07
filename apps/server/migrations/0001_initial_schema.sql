-- 0001 초기 스키마. 정본: docs/03-trd/TRD.md §2 데이터 모델.
-- 스키마 중립: 이름을 스키마로 한정하지 않는다(실행기가 search_path의 스키마에 적용). 트랜잭션은 실행기가 연다.

CREATE TABLE workspaces (
  id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT workspaces_pkey PRIMARY KEY (id)
);

CREATE TABLE users (
  id uuid NOT NULL,
  email_norm text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL,
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_email_norm_key UNIQUE (email_norm),
  CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  CONSTRAINT workspace_members_pkey PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT workspace_members_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT workspace_members_user_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT workspace_members_role_check CHECK (role IN ('owner', 'member'))
);

CREATE TABLE invites (
  id uuid NOT NULL,
  token_hash text NOT NULL,
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT invites_pkey PRIMARY KEY (id),
  CONSTRAINT invites_token_hash_key UNIQUE (token_hash),
  CONSTRAINT invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE TABLE sessions (
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT sessions_pkey PRIMARY KEY (id),
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT sessions_user_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE conversations (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  kind text NOT NULL,
  name text,
  name_norm text,
  normalized_pair_key text,
  last_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  CONSTRAINT conversations_pkey PRIMARY KEY (id),
  CONSTRAINT conversations_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT conversations_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT conversations_kind_check CHECK (kind IN ('channel', 'dm')),
  -- channel은 name_norm 필수·pair key 없음, dm은 pair key 필수·name_norm 없음(교차 값 금지는 보수적 추가).
  CONSTRAINT conversations_kind_keys_check CHECK (
    (kind = 'channel' AND name_norm IS NOT NULL AND normalized_pair_key IS NULL)
    OR (kind = 'dm' AND normalized_pair_key IS NOT NULL AND name_norm IS NULL)
  )
);

CREATE UNIQUE INDEX conversations_channel_name_norm_key ON conversations (workspace_id, name_norm) WHERE kind = 'channel';
CREATE UNIQUE INDEX conversations_dm_pair_key_key ON conversations (normalized_pair_key) WHERE kind = 'dm';

CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  joined_at timestamptz NOT NULL,
  joined_seq bigint NOT NULL,
  left_at timestamptz,
  CONSTRAINT conversation_members_pkey PRIMARY KEY (conversation_id, user_id),
  CONSTRAINT conversation_members_conversation_fkey FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE RESTRICT,
  CONSTRAINT conversation_members_user_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX conversation_members_user_conversation_idx ON conversation_members (user_id, conversation_id);

CREATE TABLE messages (
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  seq bigint NOT NULL,
  author_id uuid NOT NULL,
  client_message_id uuid NOT NULL,
  thread_root_id uuid,
  body text,
  created_at timestamptz NOT NULL,
  edited_at timestamptz,
  deleted_at timestamptz,
  -- 답글의 답글을 DB에서 거부하기 위한 보조 생성 컬럼(TRD 컬럼 외 구현 수단, 서비스가 쓰지 않는다).
  -- is_top_level: 이 행이 원문인지. thread_root_top_level: 답글이면 true, 원문이면 NULL(FK 검사 제외).
  is_top_level boolean GENERATED ALWAYS AS (thread_root_id IS NULL) STORED,
  thread_root_top_level boolean GENERATED ALWAYS AS (CASE WHEN thread_root_id IS NOT NULL THEN true END) STORED,
  CONSTRAINT messages_pkey PRIMARY KEY (id),
  CONSTRAINT messages_conversation_id_id_key UNIQUE (conversation_id, id),
  CONSTRAINT messages_conversation_id_id_top_level_key UNIQUE (conversation_id, id, is_top_level),
  CONSTRAINT messages_client_message_key UNIQUE (conversation_id, author_id, client_message_id),
  CONSTRAINT messages_conversation_fkey FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE RESTRICT,
  CONSTRAINT messages_author_fkey FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE RESTRICT,
  -- 원문은 같은 대화에 있어야 한다(복합 자기참조 FK).
  CONSTRAINT messages_thread_root_fkey FOREIGN KEY (conversation_id, thread_root_id)
    REFERENCES messages (conversation_id, id) ON DELETE RESTRICT,
  -- 원문 자체는 thread_root_id IS NULL이어야 한다(답글의 답글 거부, 답글이 달린 원문을 답글로 바꾸는 갱신도 거부).
  CONSTRAINT messages_thread_root_top_level_fkey FOREIGN KEY (conversation_id, thread_root_id, thread_root_top_level)
    REFERENCES messages (conversation_id, id, is_top_level) ON DELETE RESTRICT,
  -- 미삭제 본문 또는 삭제 tombstone만 허용.
  CONSTRAINT messages_tombstone_check CHECK (
    (deleted_at IS NULL AND body IS NOT NULL) OR (deleted_at IS NOT NULL AND body IS NULL)
  ),
  -- char_length = 문자 수(UTF8 DB에서 Unicode code point).
  CONSTRAINT messages_body_length_check CHECK (char_length(body) <= 4000),
  CONSTRAINT messages_body_nonempty_check CHECK (body <> '')
);

-- unique (conversation_id, seq)와 필수 인덱스 messages(conversation_id, seq DESC)를 한 인덱스로 겸한다.
CREATE UNIQUE INDEX messages_conversation_seq_key ON messages (conversation_id, seq DESC);
CREATE INDEX messages_conversation_thread_seq_idx ON messages (conversation_id, thread_root_id, seq);

CREATE TABLE sync_clock (
  id integer NOT NULL,
  last_change_id bigint NOT NULL DEFAULT 0,
  CONSTRAINT sync_clock_pkey PRIMARY KEY (id),
  CONSTRAINT sync_clock_singleton_check CHECK (id = 1)
);

INSERT INTO sync_clock (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE conversation_changes (
  change_id bigint NOT NULL,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  op text NOT NULL,
  created_at timestamptz NOT NULL,
  -- unique(change_id)가 필수 인덱스 conversation_changes(change_id)를 겸한다.
  CONSTRAINT conversation_changes_change_id_key UNIQUE (change_id),
  -- message FK: (conversation_id, message_id)로 걸어 대화 불일치도 막는다.
  CONSTRAINT conversation_changes_message_fkey FOREIGN KEY (conversation_id, message_id)
    REFERENCES messages (conversation_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversation_changes_op_check CHECK (op IN ('create', 'edit', 'delete'))
);

CREATE INDEX conversation_changes_conversation_change_idx ON conversation_changes (conversation_id, change_id);

CREATE TABLE conversation_read_state (
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  last_read_seq bigint NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT conversation_read_state_pkey PRIMARY KEY (conversation_id, user_id),
  CONSTRAINT conversation_read_state_conversation_fkey FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE RESTRICT,
  CONSTRAINT conversation_read_state_user_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE TABLE thread_read_state (
  root_message_id uuid NOT NULL,
  user_id uuid NOT NULL,
  last_read_seq bigint NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT thread_read_state_pkey PRIMARY KEY (root_message_id, user_id),
  CONSTRAINT thread_read_state_root_fkey FOREIGN KEY (root_message_id) REFERENCES messages (id) ON DELETE RESTRICT,
  CONSTRAINT thread_read_state_user_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE TABLE thread_unread_targets (
  root_message_id uuid NOT NULL,
  user_id uuid NOT NULL,
  qualified_at timestamptz NOT NULL,
  CONSTRAINT thread_unread_targets_pkey PRIMARY KEY (root_message_id, user_id),
  CONSTRAINT thread_unread_targets_root_fkey FOREIGN KEY (root_message_id) REFERENCES messages (id) ON DELETE RESTRICT,
  CONSTRAINT thread_unread_targets_user_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE TABLE message_mentions (
  message_id uuid NOT NULL,
  user_id uuid NOT NULL,
  CONSTRAINT message_mentions_pkey PRIMARY KEY (message_id, user_id),
  CONSTRAINT message_mentions_message_fkey FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT,
  CONSTRAINT message_mentions_user_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX message_mentions_user_message_idx ON message_mentions (user_id, message_id);
