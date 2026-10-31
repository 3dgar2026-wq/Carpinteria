ALTER TABLE users
  ALTER COLUMN email DROP NOT NULL,
  ADD COLUMN email_ciphertext TEXT,
  ADD COLUMN email_nonce TEXT,
  ADD COLUMN email_auth_tag TEXT,
  ADD COLUMN email_lookup_hmac TEXT,
  ADD CONSTRAINT users_email_encryption_fields_check CHECK (
    (email_ciphertext IS NULL AND email_nonce IS NULL AND email_auth_tag IS NULL AND email_lookup_hmac IS NULL)
    OR
    (email_ciphertext IS NOT NULL AND email_nonce IS NOT NULL AND email_auth_tag IS NOT NULL
      AND email_lookup_hmac IS NOT NULL AND email_lookup_hmac ~ '^[a-f0-9]{64}$')
  );

CREATE UNIQUE INDEX users_email_lookup_hmac_unique_idx
  ON users(email_lookup_hmac)
  WHERE email_lookup_hmac IS NOT NULL;

CREATE TABLE admin_password_recoveries (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'password_reset' CHECK (purpose = 'password_reset'),
  code_hmac TEXT CHECK (code_hmac IS NULL OR code_hmac ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  verified_at TIMESTAMPTZ,
  reset_token_hash TEXT CHECK (reset_token_hash IS NULL OR reset_token_hash ~ '^[a-f0-9]{64}$'),
  reset_token_expires_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((reset_token_hash IS NULL) = (reset_token_expires_at IS NULL))
);

CREATE INDEX admin_password_recoveries_expiry_idx
  ON admin_password_recoveries(expires_at);

CREATE TABLE admin_password_recovery_rate_limits (
  scope TEXT NOT NULL CHECK (scope IN (
    'request-global', 'request-account', 'request-ip',
    'verify-global', 'verify-account', 'verify-ip'
  )),
  bucket_hash TEXT NOT NULL CHECK (bucket_hash ~ '^[a-f0-9]{64}$'),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, bucket_hash)
);

CREATE INDEX admin_password_recovery_rate_limits_updated_idx
  ON admin_password_recovery_rate_limits(updated_at);
