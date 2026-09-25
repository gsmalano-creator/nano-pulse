-- "Have I seen this key before?"
--
-- The caller supplies the key; nothing is generated here. It is a Stripe event
-- id, a delivery id, an order number -- an identifier they already hold. The
-- product is the memory, not the value.
--
-- Rows expire. A key is a claim about a bounded window ("not twice within 24
-- hours"), never a permanent record, because permanent would make this a
-- database rather than an operation.
CREATE TABLE IF NOT EXISTS uniq_keys (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id),
  key           TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  -- How many times the key has arrived in the current window. 1 means this
  -- call created or reset it, which is how "first time" is decided: comparing
  -- timestamps would call two arrivals in the same second both first.
  hits          INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_uniq_keys_user_key ON uniq_keys (user_id, key);
-- The sweep deletes by expiry, and trims a user who is over the live cap
-- oldest-first.
CREATE INDEX IF NOT EXISTS idx_uniq_keys_expires ON uniq_keys (expires_at);
CREATE INDEX IF NOT EXISTS idx_uniq_keys_user_seen ON uniq_keys (user_id, first_seen_at);
