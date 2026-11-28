-- The project's own quota brake (limiti-consumo-progetto, USAGE-29/30):
-- one row per project that has ever been configured or paused.
--
-- `limit_24h_pct` and `limit_none` are the only things a person writes:
-- `limit_24h_pct` is the chosen limit, `limit_none = 1` is the choice "None"
-- (no limit). A row born from the brake itself (a pause or a confirmation)
-- leaves both unset (NULL, 0), and then the limit is whatever
-- `resolveProjectLimit` says for a project nobody configured, exactly like a
-- project with no row at all.
--
-- `paused_at` / `continued_until_pct` / `hold_until` are the pause's own
-- state, written by the brake and the confirmation, never by a person
-- directly:
--  - `paused_at`: when the project entered pause, NULL when it is not paused.
--  - `continued_until_pct`: set by "Continua" — the 24h points value the
--    project is allowed to reach again before the confirmation returns
--    (current points + 10). NULL when no continuation is in force.
--  - `hold_until`: set by "Pausa fino a domani" — local midnight in epoch ms;
--    the project stays paused until this passes, regardless of points.
CREATE TABLE IF NOT EXISTS project_quota (
  project_id          TEXT PRIMARY KEY,
  limit_24h_pct        REAL,
  limit_none           INTEGER NOT NULL DEFAULT 0,
  paused_at            TEXT,
  continued_until_pct  REAL,
  hold_until           INTEGER,
  updated_at           TEXT NOT NULL
);
