-- Migration number: 0006 	 2026-09-23T15:00:00.000Z
-- Self-service signup. The table is both the rate limiter's memory and an
-- audit trail of who asked for a key and from where.

CREATE TABLE IF NOT EXISTS signups (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- The two windows the limiter asks about.
CREATE INDEX IF NOT EXISTS idx_signups_ip ON signups (ip, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signups_recent ON signups (created_at DESC);
