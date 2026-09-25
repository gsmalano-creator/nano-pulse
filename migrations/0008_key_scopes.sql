-- Read-only API keys.
--
-- Existing keys become 'write' so nothing in flight breaks: the column is NOT
-- NULL with a default, and every key issued before this migration was full
-- access in practice. New read keys are opt-in at creation and cannot be
-- changed afterwards -- a key that could widen its own scope would not be a
-- scope at all.
ALTER TABLE api_keys
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'write' CHECK (scope IN ('read', 'write'));

CREATE INDEX IF NOT EXISTS idx_api_keys_user_scope ON api_keys (user_id, scope);
