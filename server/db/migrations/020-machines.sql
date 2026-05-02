-- 020-machines.sql: Phase D — first-class Machine entity.
--
-- Each row represents a host where a Topics daemon is running (or has
-- run recently). The local row is auto-upserted by the heartbeat ticker
-- every 30 s. Remote machines (when the server starts forwarding
-- heartbeats over a backend relay) are written by that ingress.

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  arch TEXT NOT NULL,
  platform TEXT NOT NULL,
  daemon_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'online' CHECK(status IN ('online', 'offline')),
  last_heartbeat_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  acknowledged_warnings TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_machines_hostname ON machines(hostname);
CREATE INDEX IF NOT EXISTS idx_machines_heartbeat ON machines(last_heartbeat_at);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES (20, '020-machines', datetime('now'));
