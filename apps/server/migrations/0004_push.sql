-- 0004 Web Push 구독. 정본: docs/03-trd/TRD.md §2 `push_subscriptions` 행, §6-2(R3.3, ADR-001 §3-i).
-- 스키마 중립: 이름을 스키마로 한정하지 않는다(실행기가 search_path의 스키마에 적용). 트랜잭션은 실행기가 연다.
-- 세션은 삭제가 아니라 revoked_at으로 폐기되므로, 폐기 경로(auth repo·세션 폐기 이벤트)가 구독 행을 함께 지운다.

CREATE TABLE push_subscriptions (
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_id uuid,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  vapid_key_id text NOT NULL,
  created_at timestamptz NOT NULL,
  last_success_at timestamptz,
  CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint),
  CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT push_subscriptions_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
);

CREATE INDEX push_subscriptions_user_id_idx ON push_subscriptions (user_id);
CREATE INDEX push_subscriptions_session_id_idx ON push_subscriptions (session_id);
