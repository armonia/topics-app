-- Phase 30 PANE-01/PANE-02/PANE-04: add payload versioning and monotonic server sequence
-- for LWW conflict resolution across devices.
--
-- MIGRATION NOTES:
--   * Pre-existing rows take DEFAULT 0 for server_seq. The first server-side
--     write to each key (via the v2 INSERT ... ON CONFLICT ... path in
--     server/routes/ui-state.ts) allocates MAX(server_seq)+1 across the table,
--     so the first post-migration write always wins the LWW race over any
--     legacy-seed v1 row. Client middlewares (syncWS, syncCrossTab) treat
--     seq=0 as "older than everything" — intentional; the first real write
--     supersedes it.
--   * payload_version=1 on pre-existing rows is backward-compat only; writes
--     always stamp 2 via the UPSERT in server/routes/ui-state.ts and
--     server/routes/topics.ts#purgeTopicFromUiState.
--
-- IDEMPOTENCY / RE-RUN:
--   * The migration runner (server/db.ts :: runMigrations) guards re-exec by
--     consulting schema_migrations FIRST. A successfully recorded migration
--     is skipped on subsequent starts.
--   * A "duplicate column name" error stops startup and rolls back this
--     migration's transaction. An existing column does not prove that the
--     other column or index exists, so the runner does not record success.
--     A mismatch between schema and registry requires a specific recovery;
--     see docs/backup-pre-migration-policy.md.
--   * The INSERT below preserves the historical registry convention; the
--     runner normalizes its stem to the canonical filename after execution.
--     OR IGNORE protects that INSERT, not the ALTER TABLE statements.
--   * SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Re-running
--     this file directly does not provide the runner's idempotency guard.
--
-- ROLLBACK:
--   * rollback: not supported (NOT NULL without DEFAULT backfill).
--     SQLite's ALTER TABLE DROP COLUMN (3.35+) would leave the
--     server_seq index stale; and downgrading clients read an additive
--     schema fine, so the intended recovery path is forward-fix, not
--     backward-unapply.

ALTER TABLE ui_state ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ui_state ADD COLUMN server_seq INTEGER NOT NULL DEFAULT 0;

-- Create an index on server_seq for WS broadcast ordering and any future "since X" queries.
CREATE INDEX IF NOT EXISTS ui_state_server_seq_idx ON ui_state(server_seq);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (12, 'ui-state-payload-version', datetime('now'));
