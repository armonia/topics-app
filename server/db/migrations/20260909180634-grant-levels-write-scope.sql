-- A GUEST CAN BE GRANTED MORE THAN "READ".
--
-- Both `task-sharing-guests` and `sharing-orgs` named this exact gap and
-- deliberately left it out: the vocabulary was widened to `('read', 'deny')`
-- so the CHECK would not need a second rebuild, but the levels a collaborator
-- actually needs — comment on a shared task, edit it, start or stop its
-- execution, manage who else it is shared with — were never added, and
-- neither was anything that enforces them.
--
-- Five ordered levels replace the binary one: `read` < `comment` < `edit` <
-- `run` < `manage`, plus `deny` which still overrides all of them (see
-- `grants-query.ts`, `LEVEL_RANK`). Ordered so a capability check can ask
-- "at least X" once instead of enumerating every level that qualifies.
--
-- SQLite cannot alter a CHECK in place: the table is recreated and the rows
-- copied across untouched. The constraint only WIDENS, so every existing row
-- — all of them `read` or `deny` today — still satisfies it.
PRAGMA foreign_keys = OFF;

CREATE TABLE grants_nuova (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('device', 'person', 'org')),
  subject_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('task', 'topic', 'project')),
  resource_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('read', 'comment', 'edit', 'run', 'manage', 'deny')),
  granted_at INTEGER NOT NULL,
  granted_by_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  via_type TEXT,
  via_id TEXT,
  UNIQUE (subject_type, subject_id, resource_type, resource_id)
);

INSERT INTO grants_nuova
  SELECT id, subject_type, subject_id, resource_type, resource_id,
         level, granted_at, granted_by_person_id, via_type, via_id
    FROM grants;

DROP TABLE grants;
ALTER TABLE grants_nuova RENAME TO grants;

CREATE INDEX IF NOT EXISTS idx_grants_subject ON grants(subject_type, subject_id, resource_type);
CREATE INDEX IF NOT EXISTS idx_grants_resource ON grants(resource_type, resource_id);

PRAGMA foreign_keys = ON;
