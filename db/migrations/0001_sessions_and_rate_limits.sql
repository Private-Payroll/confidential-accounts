-- 0001 — sessions we can revoke, and a login limiter that actually limits.
--
-- Two tables, both born on Postgres rather than migrated onto it. Neither has
-- an existing synchronous caller, which is why they can come first: moving the
-- main `DataStore` off the JSON file is a separate, larger job (235 call sites)
-- and this work does not have to wait for it.
--
-- Nothing here holds anything sealed. These are Tier-4 operational rows —
-- opaque ids, hashes and timestamps — and they must stay that way.

CREATE TABLE IF NOT EXISTS sessions (
  -- The SHA-256 of the token, never the token. A stolen database backup must
  -- not be a stack of working sessions, which is what storing the token itself
  -- would make it. Same reasoning as never storing a password.
  token_hash   bytea       PRIMARY KEY,
  user_id      text        NOT NULL,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  -- Set when the session is revoked. Kept rather than deleted so "signed out"
  -- and "never existed" stay distinguishable — the first is an audit fact.
  revoked_at   timestamptz,
  -- Coarse provenance, for showing someone their own sessions and for
  -- revoking the others. Deliberately not an IP: that is personal data we have
  -- no use for once the request is served.
  user_agent   text
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

-- The login limiter. S-2.
--
-- WHY THIS IS A TABLE AND NOT A COUNTER IN MEMORY: argon2id runs on the
-- CLIENT, so what reaches the server is a cheap-to-test 32-byte key. An
-- in-process counter is per-instance, so two instances double the allowance
-- and a restart clears it — and the whole point is to make guessing expensive.
--
-- The bucket is (scope, key, window_start): scope is 'email' or 'ip', so the
-- two limits are the same mechanism twice rather than two mechanisms.
CREATE TABLE IF NOT EXISTS login_attempts (
  scope        text        NOT NULL,
  key          text        NOT NULL,
  window_start timestamptz NOT NULL,
  attempts     integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key, window_start)
);

CREATE INDEX IF NOT EXISTS login_attempts_window_idx ON login_attempts (window_start);
