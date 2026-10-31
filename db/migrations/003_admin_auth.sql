CREATE TABLE admin_sessions (
  session_token_hash CHAR(64) PRIMARY KEY
    CHECK (session_token_hash ~ '^[a-f0-9]{64}$'),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token CHAR(64) NOT NULL CHECK (csrf_token ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX admin_sessions_expires_at_idx ON admin_sessions(expires_at);

CREATE TABLE admin_login_attempts (
  bucket_hash CHAR(64) PRIMARY KEY CHECK (bucket_hash ~ '^[a-f0-9]{64}$'),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX admin_login_attempts_updated_at_idx ON admin_login_attempts(updated_at);
