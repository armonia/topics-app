-- v3 foundations AGENT-02 — Append-only epoch timeline for agent sessions.
--
-- An "epoch" is a single run of a managed agent inside an agent_session.
-- Each session can have many epochs (new run = new epoch row, never updated).
-- Each epoch carries a stream of events recorded as JSON payloads in a sibling
-- table. The timeline is append-only: rows are never updated or deleted,
-- only inserted. This makes the schema crash-safe — a daemon restart loses
-- zero history.
--
-- Schema goals:
--   - Bounded retention: max 200 events per agent (enforced in code via
--     DELETE FROM agent_epoch_events WHERE rowid IN (... oldest 200+ ...)).
--     SQL just stores; eviction is policy.
--   - Cheap reads: index on (session_id, epoch_index, sequence) for the
--     timeline-view endpoint.
--   - Easy joins: epoch.session_id FK to agent_sessions, event.epoch_id FK
--     to agent_epochs.
--
-- This is the FOUNDATION. AGENT-03 (kill JSONL polling) and AGENT-04..08
-- consume this surface.

CREATE TABLE IF NOT EXISTS agent_epochs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  epoch_index INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT CHECK(end_reason IS NULL OR end_reason IN ('completed', 'error', 'stale', 'aborted')),
  UNIQUE(session_id, epoch_index)
);

CREATE INDEX IF NOT EXISTS idx_agent_epochs_session ON agent_epochs(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_epochs_started ON agent_epochs(started_at);

-- Append-only event stream per epoch. Each row is a single observation:
--   - 'state_transition' — FSM state change with from/to in payload
--   - 'tool_call'        — tool invocation with name/args/result in payload
--   - 'permission_request' — agent asks user for permission
--   - 'permission_response' — user replies
--   - 'token_usage'      — provider reported token counts (for AGENT-04 NaN fix)
--   - 'note'             — generic log/debug event
--
-- The `payload` column is JSON text; readers JSON.parse and Zod-validate
-- per event_type at the boundary.

CREATE TABLE IF NOT EXISTS agent_epoch_events (
  id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL REFERENCES agent_epochs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'state_transition',
    'tool_call',
    'permission_request',
    'permission_response',
    'token_usage',
    'note'
  )),
  payload TEXT NOT NULL DEFAULT '{}',
  recorded_at TEXT NOT NULL,
  UNIQUE(epoch_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_agent_epoch_events_epoch ON agent_epoch_events(epoch_id);
CREATE INDEX IF NOT EXISTS idx_agent_epoch_events_type ON agent_epoch_events(event_type);
CREATE INDEX IF NOT EXISTS idx_agent_epoch_events_time ON agent_epoch_events(recorded_at);
