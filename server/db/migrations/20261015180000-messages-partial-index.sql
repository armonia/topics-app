-- The boot sweep (boot-partial-sweep.ts) looks for messages a crash left half
-- written. Without an index it walked every message to find none: 1,045 ms on
-- the live database of 15/10/2026, under memory pressure. Partial, so only the
-- rows still being written are in it: empty at rest.
CREATE INDEX IF NOT EXISTS idx_messages_partial ON messages(session_key) WHERE partial = 1;
