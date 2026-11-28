-- Daily backlog triage, a per-board switch. 0 = off (the default): a board that
-- never heard of it keeps its backlog exactly as people left it. 1 = twice a
-- day a cheap model sorts every backlog card into todo / a question for the
-- person / already done (only with a verified proof) / stays.
ALTER TABLE board_settings ADD COLUMN backlog_triage INTEGER NOT NULL DEFAULT 0;

-- One row per board and half-day slot ("YYYY-MM-DD@HH"): the claim that keeps a
-- restart from sorting the same backlog twice in the same slot.
CREATE TABLE IF NOT EXISTS backlog_triage_runs (
  board_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  at TEXT NOT NULL,
  summary TEXT,
  PRIMARY KEY (board_id, slot)
);
