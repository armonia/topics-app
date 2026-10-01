/**
 * THE ROWS OF `command_runs`: a command of a reply, run by a person with Run
 * under its code block (CMDRUN-05, CMDRUN-06).
 *
 * The run itself is a process of the registry (`routes/processes.ts`, a
 * `run_command` with origin `person`); this is what outlives it there. The
 * registry keeps its ten most recent rows and seven days of logs, and the
 * outcome under a block has to be there after a reload, on another device, a
 * month later. The table and why each column is there: migration
 * `20261001220421-command-runs.sql`.
 */
import type { Database } from "bun:sqlite";

/** The most of a run's output kept in its row: the end, where a command says how it went. */
export const RUN_OUTPUT_MAX_BYTES = 256 * 1024;

export type RunStatus = "running" | "done" | "error" | "stopped" | "unknown";

/** A run as the client reads it. `output` is null while it runs: then it is read from the registry. */
export interface CommandRun {
  runId: string;
  blockKey: number;
  command: string;
  cwd: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  output: string | null;
  droppedLines: number;
}

/**
 * The end of an output that fits in `maxBytes`, made of whole lines, and how
 * many lines were left out before it. `lines` are complete lines, oldest first;
 * `alreadyDropped` the lines the registry's buffer had already let go.
 */
export function tailForStorage(lines: readonly string[], alreadyDropped: number, maxBytes = RUN_OUTPUT_MAX_BYTES): { output: string; droppedLines: number } {
  let bytes = 0;
  let from = lines.length;
  while (from > 0) {
    // +1 for the newline that joins it to the line after.
    const size = Buffer.byteLength(lines[from - 1]!) + (from < lines.length ? 1 : 0);
    if (bytes + size > maxBytes) break;
    bytes += size;
    from--;
  }
  return { output: lines.slice(from).join("\n"), droppedLines: alreadyDropped + from };
}

export function insertRun(db: Database, run: {
  id: string; sessionKey: string; messageId: string; blockKey: number; command: string; cwd: string;
  startedAt: string; authorDeviceId: string | null;
}): void {
  db.prepare(
    `INSERT INTO command_runs (id, session_key, message_id, block_key, command, cwd, status, started_at, author_device_id)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
  ).run(run.id, run.sessionKey, run.messageId, run.blockKey, run.command, run.cwd, run.startedAt, run.authorDeviceId);
}

/**
 * Close a run that is still `running`. True when a row changed: a run already
 * closed (the boot's catch-up meeting a row closed before) stays as it was.
 */
export function closeRun(db: Database, id: string, end: {
  status: Exclude<RunStatus, "running">; exitCode: number | null; endedAt: string; output: string; droppedLines: number;
}): boolean {
  const res = db.prepare(
    `UPDATE command_runs SET status = ?, exit_code = ?, ended_at = ?, output = ?, dropped_lines = ?
     WHERE id = ? AND status = 'running'`,
  ).run(end.status, end.exitCode, end.endedAt, end.output, end.droppedLines, id);
  return res.changes > 0;
}

/** Where the run of `id` belongs: its session and message, for the frame. Null once it is gone with its message. */
export function runOwner(db: Database, id: string): { sessionKey: string; messageId: string } | null {
  const row = db.query("SELECT session_key, message_id FROM command_runs WHERE id = ?").get(id) as { session_key: string; message_id: string } | null;
  return row ? { sessionKey: row.session_key, messageId: row.message_id } : null;
}

/** For each block of a message of the session, its last run. */
export function latestRuns(db: Database, sessionKey: string, messageId: string): CommandRun[] {
  const rows = db.query(
    `SELECT id, block_key, command, cwd, status, exit_code, started_at, ended_at, output, dropped_lines
     FROM command_runs WHERE message_id = ? AND session_key = ? ORDER BY block_key, started_at DESC, rowid DESC`,
  ).all(messageId, sessionKey) as Array<{
    id: string; block_key: number; command: string; cwd: string; status: RunStatus; exit_code: number | null;
    started_at: string; ended_at: string | null; output: string | null; dropped_lines: number;
  }>;
  const out: CommandRun[] = [];
  for (const r of rows) {
    if (out.at(-1)?.blockKey === r.block_key) continue;
    out.push({
      runId: r.id, blockKey: r.block_key, command: r.command, cwd: r.cwd, status: r.status, exitCode: r.exit_code,
      startedAt: r.started_at, endedAt: r.ended_at, output: r.output, droppedLines: r.dropped_lines,
    });
  }
  return out;
}
