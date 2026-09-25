-- Counters that cannot go backwards.
--
-- A plain counter may be set to any value: "the download count is really
-- 12300" is a reasonable thing to say while migrating. A sequence cannot
-- afford that. Invoice number 42 twice is an accounting problem, so a counter
-- created with monotonic = 1 refuses a negative step and refuses any write
-- that would not move it forward.
--
-- Fixed at creation. A counter that could drop the guarantee would not have
-- one, which is the same reason api_keys.scope is immutable. Existing counters
-- become 0: they were free to move either way, and silently constraining them
-- could break a caller that relies on it.
ALTER TABLE counters
  ADD COLUMN monotonic INTEGER NOT NULL DEFAULT 0 CHECK (monotonic IN (0, 1));
