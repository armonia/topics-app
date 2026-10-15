-- 20261014225051-scheduled-cards.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- Card a calendario: una ricorrenza della board crea la sua card all'ora giusta, nel
-- fuso scritto nella riga. Lo scheduler non tiene niente in memoria: `next_run_at`
-- dice cosa è dovuto, e UNIQUE(scheduled_card_id, occurrence_key) impedisce che un
-- riavvio crei due volte la stessa occorrenza.
CREATE TABLE scheduled_cards (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('backlog', 'todo', 'in_progress', 'review')),
  labels_json TEXT NOT NULL DEFAULT '[]',
  cron TEXT NOT NULL,
  time_zone TEXT NOT NULL DEFAULT 'Europe/Rome',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  last_result TEXT,
  last_reason TEXT,
  last_occurrence_key TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX scheduled_cards_due ON scheduled_cards(enabled, next_run_at) WHERE deleted_at IS NULL;

CREATE TABLE scheduled_card_instances (
  id TEXT PRIMARY KEY,
  scheduled_card_id TEXT NOT NULL REFERENCES scheduled_cards(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(scheduled_card_id, occurrence_key)
);
