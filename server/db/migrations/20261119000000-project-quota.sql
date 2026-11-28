-- The project's own quota brake (limiti-consumo-progetto, USAGE-29/30):
-- one row per project that has ever been configured or paused.
--
-- `limit_24h_pct` is the only thing a person writes: NULL means "no limit"
-- (chosen from the project menu), and a row that does not exist yet reads as
-- the DEFAULT of 10 (see `server/services/project-pause.ts`), not as
-- unlimited — the default has to hold with zero configuration, so it cannot
-- live only in a column default that an absent row never sees.
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
  paused_at            TEXT,
  continued_until_pct  REAL,
  hold_until           INTEGER,
  updated_at           TEXT NOT NULL
);
