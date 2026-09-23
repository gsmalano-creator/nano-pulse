-- Migration number: 0004 	 2026-09-23T11:00:00.000Z
-- NanoLock: mutual exclusion over HTTP. One row per (user, name); the row
-- survives expiry so the fence counter keeps increasing across acquisitions.

CREATE TABLE IF NOT EXISTS locks (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- Secret proving ownership. Release and renew require it, so a stalled
    -- holder cannot release a lock somebody else has since acquired.
    token TEXT NOT NULL,
    -- Free text from the caller: hostname, pod name, run id.
    owner TEXT,
    -- Monotonically increasing per lock name. Handed to the holder so a
    -- downstream resource can reject writes from a fenced-off older holder.
    fence INTEGER NOT NULL DEFAULT 1,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_locks_expiry ON locks (expires_at);
