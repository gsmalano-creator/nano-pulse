-- Migration number: 0001 	 2026-09-22T00:00:00.000Z
-- NanoPulse core schema. All timestamps are unix epoch seconds (UTC).

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    -- Only the SHA-256 hash of the key is stored. key_prefix is the
    -- human-readable part we can safely show in a UI.
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_used_at INTEGER,
    revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);

CREATE TABLE IF NOT EXISTS monitors (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT,
    expected_interval_seconds INTEGER NOT NULL DEFAULT 3600,
    grace_period_seconds INTEGER NOT NULL DEFAULT 300,
    -- pending = created but never pinged, ok = alive, down = missed its window,
    -- paused = ignored by the cron checker.
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'down', 'paused')),
    last_ping_at INTEGER,
    alert_webhook_url TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (user_id, slug)
);

-- The cron checker scans on status + deadline, so index that path.
CREATE INDEX IF NOT EXISTS idx_monitors_due ON monitors (status, last_ping_at);

CREATE TABLE IF NOT EXISTS ping_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    received_at INTEGER NOT NULL DEFAULT (unixepoch()),
    reported_status TEXT NOT NULL DEFAULT 'ok' CHECK (reported_status IN ('ok', 'fail')),
    source_ip TEXT,
    user_agent TEXT,
    payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_ping_logs_monitor ON ping_logs (monitor_id, received_at DESC);

-- State transitions (down/up) so the API can answer "what happened and when".
CREATE TABLE IF NOT EXISTS monitor_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN ('down', 'up')),
    message TEXT,
    notified INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_monitor_events_monitor ON monitor_events (monitor_id, created_at DESC);
