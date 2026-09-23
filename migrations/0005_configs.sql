-- Migration number: 0005 	 2026-09-23T13:00:00.000Z
-- NanoConfig: small named JSON documents, read hot and written rarely.
-- Kill switches, feature flags, anything you would otherwise redeploy for.

CREATE TABLE IF NOT EXISTS configs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- The whole document, as stored. Always a JSON object.
    data TEXT NOT NULL DEFAULT '{}',
    -- Increments on every write and never rewinds, including on rollback:
    -- a client that caches by version must never see the same number twice
    -- with different content.
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS config_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id TEXT NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_config_revisions ON config_revisions (config_id, version DESC);
