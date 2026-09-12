-- 20260912115225-delegated-agent-start.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- Add the owner-issued capability that permits a confined guest to enqueue one
-- existing task. Content grants remain independent. Every execution binding is
-- copied onto the task and audit row so revocation and reload do not need to
-- reconstruct authority from mutable memberships.
--   bun run scripts/gen-migrations-manifest.ts   (se hai toccato il nome)
--   bun run check:migrations

CREATE TABLE agent_start_capabilities (
  id TEXT PRIMARY KEY,
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('device', 'person', 'org')),
  recipient_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  repository_key TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  max_duration_minutes INTEGER NOT NULL CHECK (max_duration_minutes BETWEEN 1 AND 1440),
  max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts = 1),
  fanout INTEGER NOT NULL DEFAULT 1 CHECK (fanout = 1),
  granted_by_person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  revoked_by_person_id TEXT REFERENCES people(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_agent_start_capability_live_subject_project
  ON agent_start_capabilities(recipient_kind, recipient_id, project_id)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_agent_start_capability_project
  ON agent_start_capabilities(project_id, revoked_at, expires_at);

-- A remote machine owner grants this mapping independently. A project-owner
-- capability is effective on a remote node only while both records are live.
CREATE TABLE machine_repository_authorizations (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  repository_key TEXT NOT NULL,
  authorized_by_person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  authorized_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by_person_id TEXT REFERENCES people(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_machine_repository_authorization_live
  ON machine_repository_authorizations(machine_id, repository_key)
  WHERE revoked_at IS NULL;

-- The execution computer owns this credential. Incoming node requests look it
-- up by hash and derive every policy field from this row; the request body is
-- never execution authority.
CREATE TABLE delegated_node_authorizations (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL UNIQUE,
  credential_hash TEXT NOT NULL UNIQUE,
  subject_person_id TEXT,
  subject_device_id TEXT NOT NULL,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  repository_key TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  max_duration_minutes INTEGER NOT NULL CHECK (max_duration_minutes BETWEEN 1 AND 1440),
  max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts = 1),
  fanout INTEGER NOT NULL DEFAULT 1 CHECK (fanout = 1),
  authorized_by_person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  authorized_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  revoked_by_person_id TEXT REFERENCES people(id) ON DELETE SET NULL
);

CREATE INDEX idx_delegated_node_authorization_live
  ON delegated_node_authorizations(machine_id, repository_key, revoked_at, expires_at);

-- Durable, purpose-specific handshake between two installations.  An origin
-- row keeps the opaque claim so only its server can retrieve the credential;
-- a node row keeps only its hash.  The browser is only ever shown state/code.
CREATE TABLE delegated_node_requests (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('origin', 'node')),
  purpose TEXT NOT NULL CHECK (purpose IN ('catalog', 'authorization')),
  remote_request_id TEXT,
  claim_secret TEXT,
  claim_hash TEXT,
  code TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'active', 'denied', 'expired', 'revoked')),
  machine_id TEXT NOT NULL,
  base_url TEXT,
  capability_id TEXT,
  repository_key TEXT NOT NULL,
  origin_person_id TEXT,
  origin_device_id TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  max_duration_minutes INTEGER CHECK (max_duration_minutes BETWEEN 1 AND 1440),
  authorization_id TEXT,
  local_project_id TEXT,
  local_person_id TEXT,
  models_json TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoke_pending INTEGER NOT NULL DEFAULT 0 CHECK (revoke_pending IN (0,1)),
  last_error TEXT,
  UNIQUE(direction, remote_request_id)
);

CREATE INDEX idx_delegated_node_requests_state
  ON delegated_node_requests(direction, state, expires_at);

-- A catalog is evidence returned by that node's confined approval, never a
-- guess based on providers installed on the origin computer.
CREATE TABLE machine_delegated_model_catalogs (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  repository_key TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  models_json TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (machine_id, repository_key)
);

-- These are audit bindings, not ownership pointers. They deliberately retain
-- ids after a person, device or capability is revoked.
ALTER TABLE tasks ADD COLUMN delegated_start_capability_id TEXT;
ALTER TABLE tasks ADD COLUMN run_initiator_person_id TEXT;
ALTER TABLE tasks ADD COLUMN run_initiator_device_id TEXT;

CREATE INDEX idx_tasks_delegated_start_capability
  ON tasks(delegated_start_capability_id)
  WHERE delegated_start_capability_id IS NOT NULL;

CREATE TABLE delegated_run_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capability_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  initiator_person_id TEXT,
  initiator_device_id TEXT NOT NULL,
  execution_session_id TEXT,
  machine_id TEXT NOT NULL,
  repository_key TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  max_duration_minutes INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL CHECK (max_attempts = 1),
  fanout INTEGER NOT NULL CHECK (fanout = 1),
  phase TEXT NOT NULL CHECK (phase IN ('queued', 'dispatch', 'resume', 'cancelled', 'completed', 'failed')),
  outcome TEXT,
  deadline_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_delegated_run_audit_task ON delegated_run_audit(task_id, created_at);
CREATE INDEX idx_delegated_run_audit_capability ON delegated_run_audit(capability_id, created_at);

-- Node-local binding for the confined delegated path. The node validates every
-- create/read/cancel/bundle operation against this immutable envelope.
CREATE TABLE delegated_node_runs (
  run_id TEXT PRIMARY KEY,
  origin_task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  authorization_id TEXT NOT NULL REFERENCES delegated_node_authorizations(id) ON DELETE RESTRICT,
  subject_person_id TEXT,
  subject_device_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  repository_key TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  max_duration_minutes INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL CHECK (max_attempts = 1),
  fanout INTEGER NOT NULL CHECK (fanout = 1),
  expires_at INTEGER,
  revoked_at INTEGER,
  deadline_at INTEGER NOT NULL,
  cancel_requested_at INTEGER,
  cancel_confirmed_at INTEGER,
  cancel_error TEXT,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES (20260912115225, '20260912115225-delegated-agent-start', datetime('now'));
