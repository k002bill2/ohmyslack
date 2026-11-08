-- 0002 봇 계정·봇 토큰. 정본: docs/03-trd/TRD.md §2 `users`·`bot_tokens` 행, §5-2 1·2항(R3.3, ADR-001).
-- 스키마 중립: 이름을 스키마로 한정하지 않는다(실행기가 search_path의 스키마에 적용). 트랜잭션은 실행기가 연다.
-- 기존 행 보존: 0001의 users는 모두 사람이고 password_hash가 NOT NULL이었으므로 kind 기본값 'human'으로 CHECK를 만족한다.

ALTER TABLE users ADD COLUMN kind text NOT NULL DEFAULT 'human';
ALTER TABLE users ADD CONSTRAINT users_kind_check CHECK (kind IN ('human', 'bot'));
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
-- 사람은 항상 해시가 있고, 봇은 항상 해시가 없다(봇은 이메일·비밀번호 로그인 경로가 원천적으로 없다).
ALTER TABLE users ADD CONSTRAINT users_kind_password_check CHECK ((kind = 'human') = (password_hash IS NOT NULL));

CREATE TABLE bot_tokens (
  id uuid NOT NULL,
  bot_user_id uuid NOT NULL,
  token_hash text NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT bot_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT bot_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT bot_tokens_bot_user_fkey FOREIGN KEY (bot_user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- 필수 인덱스(TRD §2): 봇당 미폐기 토큰 조회. 상한 2개는 서비스가 봇 users 행 잠금 아래에서 검사한다.
CREATE INDEX bot_tokens_live_idx ON bot_tokens (bot_user_id) WHERE revoked_at IS NULL;
