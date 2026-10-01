-- 20261001220421-command-runs.sql
--
-- The prefix is a UTC timestamp (YYYYMMDDHHMMSS), not a counter: it is what
-- makes a collision between parallel cards impossible. Do not rename it.
--
-- A command the agent wrote in a reply, run by the person with Run under its
-- code block (openspec change chat-inline-command-run, CMDRUN-06).
--
-- The run itself is a `run_command` process of the registry
-- (`server/routes/processes.ts`), which keeps the ten most recent rows and the
-- logs for seven days. The outcome under a block has to outlive both: after a
-- reload, on another device, a month later. So the row is written when the
-- run starts and closed by `finishCommand` with its code, its end and the
-- last 256 KB of its output, cut at a line start, with the count of the lines
-- that did not fit.
--
-- `id` is the registry's processId: while the run is going its output is read
-- from the registry's cursor, and `output` stays NULL.
--
-- `block_key` says WHICH block of the message: the offset of the code block in
-- the text it was rendered from (plus the text segment, see
-- `client/src/components/Chat/commandRunContext.ts`). The client binds a run
-- to a block only when the key AND the command match what it draws.
--
-- ON DELETE CASCADE on the message: a run lives exactly as long as the reply
-- it ran from (every server connection runs with `PRAGMA foreign_keys = ON`).
-- ON DELETE SET NULL on the device: forgetting a device does not erase what
-- was run from it, nor is it refused because of it.
CREATE TABLE IF NOT EXISTS command_runs (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  block_key INTEGER NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  -- running | done | error | stopped | unknown
  status TEXT NOT NULL,
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  output TEXT,
  dropped_lines INTEGER NOT NULL DEFAULT 0,
  author_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_command_runs_message ON command_runs(message_id, block_key, started_at);
