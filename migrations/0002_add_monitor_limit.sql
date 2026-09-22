-- Migration number: 0002 	 2026-09-22T12:10:00.000Z
-- Per-user quota. Plans are not modelled as rows: a "plan" is just a number you
-- set on the user, so upgrading a customer is a single UPDATE. For an effectively
-- unlimited customer, set a large number.
ALTER TABLE users ADD COLUMN monitor_limit INTEGER NOT NULL DEFAULT 5;
