-- 20260907120000-agent-bin-paths.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- Scrivi qui SOTTO cosa cambia e perché. Poi:
--   bun run scripts/gen-migrations-manifest.ts   (se hai toccato il nome)
--   bun run check:migrations

--
-- Where an agent CLI lives, when the person had to say it by hand.
--
-- Topics probes a list of known install locations for `claude`, `codex` and the
-- others. The list cannot be complete: a custom npm prefix, a version manager,
-- a portable install on another volume. Until now whoever installed the CLI
-- somewhere else had no way to tell the app, and Settings simply said the
-- provider was not there (card 38d9f64b).
--
-- One TEXT column holding a JSON object `{"codex": "/abs/path", …}` keyed by the
-- agent id, not one column per agent: the set of agents is a table in the code
-- (`server/lib/detect-agents.ts`) and it grows, and a schema change per agent
-- added is a migration nobody would remember to write.

ALTER TABLE app_settings ADD COLUMN agent_bin_paths TEXT;
