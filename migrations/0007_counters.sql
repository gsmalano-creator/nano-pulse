-- Migration number: 0007 	 2026-09-23T17:00:00.000Z
-- NanoCount: named counters, plus a badge anyone can embed.

CREATE TABLE IF NOT EXISTS counters (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    -- Default label for the badge; overridable per request.
    label TEXT,
    -- Unguessable id used by the unauthenticated badge and JSON read, so a
    -- README can embed one counter without exposing the account.
    public_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_counters_user ON counters (user_id, name);
