-- Migration number: 0003 	 2026-09-22T18:50:00.000Z
-- NanoRelay: we call the customer's endpoint on a schedule.

CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT,
    -- Five-field cron expression, evaluated in `timezone`.
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    url TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'POST' CHECK (method IN ('GET', 'POST')),
    -- JSON object of extra request headers.
    headers TEXT,
    body TEXT,
    timeout_seconds INTEGER NOT NULL DEFAULT 30,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    paused INTEGER NOT NULL DEFAULT 0,
    alert_webhook_url TEXT,
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_status TEXT CHECK (last_status IN ('ok', 'failed')),
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (user_id, slug)
);

-- The sweep scans on exactly this pair.
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules (paused, next_run_at);

CREATE TABLE IF NOT EXISTS schedule_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    -- Which slot this run belongs to, so a retried run is still attributable.
    scheduled_for INTEGER,
    attempts INTEGER NOT NULL DEFAULT 1,
    outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'http_error', 'timeout', 'network_error', 'blocked')),
    status_code INTEGER,
    duration_ms INTEGER,
    response_excerpt TEXT,
    error TEXT,
    triggered_by TEXT NOT NULL DEFAULT 'schedule' CHECK (triggered_by IN ('schedule', 'manual'))
);

CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs (schedule_id, started_at DESC);
