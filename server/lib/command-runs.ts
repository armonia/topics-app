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
import type { AppContext } from "../types";
import type { CommandRun, RunStatus } from "../../shared/command-runs";

/** The most of a run's output kept in its row: the end, where a command says how it went. */
export const RUN_OUTPUT_MAX_BYTES = 256 * 1024;

/**
 * The end of an output that fits in `maxBytes`, made of whole lines, and how
 * many lines were left out before it. `lines` are complete lines, oldest first;
 * `alreadyDropped` the lines the registry's buffer had already let go.
 *
 * A last line alone over `maxBytes` (a progress bar redrawn with `\r` and no
 * newline: curl, docker pull, rsync --progress) keeps its end, cut on a
 * character, and is not counted as dropped: it is the line saying how it went.
 */
function tailForStorage(lines: readonly string[], alreadyDropped: number, maxBytes = RUN_OUTPUT_MAX_BYTES): { output: string; droppedLines: number } {
  let bytes = 0;
  let from = lines.length;
  while (from > 0) {
    // +1 for the newline that joins it to the line after.
    const size = Buffer.byteLength(lines[from - 1]!) + (from < lines.length ? 1 : 0);
    if (bytes + size > maxBytes) break;
    bytes += size;
    from--;
  }
  if (from === lines.length && from > 0) {
    const last = Buffer.from(lines[from - 1]!);
    let cut = last.length - maxBytes;
    // Not inside a UTF-8 character: past its continuation bytes (10xxxxxx).
    while (cut < last.length && (last[cut]! & 0xc0) === 0x80) cut++;
    return { output: last.subarray(cut).toString("utf8"), droppedLines: alreadyDropped + from - 1 };
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

/** How often a run writes the time of its output on its row: the error of its `unknown` end. */
const OUTPUT_NOTE_MS = 5_000;
/** When each running run last wrote that time (ms). */
const outputNotedAt = new Map<string, number>();

/**
 * The run printed at `now`: kept on its row while it is `running`, at most
 * every `OUTPUT_NOTE_MS`. The boot after a restart deletes the log of every
 * process the registry does not know, and with it the log's own time; the row
 * is what says when a run lost with the server was last alive (migration
 * `20261002192446-command-runs-last-output.sql`).
 */
export function noteRunOutput(db: Database, id: string, now = Date.now()): void {
  const last = outputNotedAt.get(id);
  if (last !== undefined && now - last < OUTPUT_NOTE_MS) return;
  outputNotedAt.set(id, now);
  try {
    db.prepare("UPDATE command_runs SET last_output_at = ? WHERE id = ? AND status = 'running'").run(new Date(now).toISOString(), id);
  } catch (err) {
    console.warn(`[command-runs] noting the output of ${id} failed:`, err);
  }
}

/** When the run of `id` last printed, as its row says; null when it never did, or is gone. */
export function runLastOutputAt(db: Database, id: string): string | null {
  const row = db.query("SELECT last_output_at FROM command_runs WHERE id = ?").get(id) as { last_output_at: string | null } | null;
  return row?.last_output_at ?? null;
}

/** Where the run of `id` belongs: its session and message, for the frame. Null once it is gone with its message. */
function runOwner(db: Database, id: string): { sessionKey: string; messageId: string } | null {
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

/**
 * The row of a person's run closes with the registry row: how it ended (a
 * Stop is `stopped`, no exit code is `unknown`, never `done`), when, and the
 * end of its output. The registry calls it from `finishCommand`, and the
 * router once more when it is created: a run that ended while the server was
 * down is closed at boot, before there is a database to write to. Closing
 * twice changes nothing.
 */
export function closeRegistryRun(ctx: Pick<AppContext, "db" | "broadcastToAll">, row: {
  processId: string; stopped: boolean; exitCode?: number; completedAt?: string; output: string[]; droppedLines?: number;
}): void {
  const status: Exclude<RunStatus, "running"> = row.stopped ? "stopped"
    : row.exitCode === undefined ? "unknown"
    : row.exitCode === 0 ? "done" : "error";
  outputNotedAt.delete(row.processId);
  const { output, droppedLines } = tailForStorage(row.output, row.droppedLines ?? 0);
  try {
    const closed = closeRun(ctx.db, row.processId, {
      status, exitCode: status === "done" || status === "error" ? row.exitCode ?? null : null,
      endedAt: row.completedAt ?? new Date().toISOString(), output, droppedLines,
    });
    if (!closed) return;
    const owner = runOwner(ctx.db, row.processId);
    if (owner) ctx.broadcastToAll({ type: "command-run:updated", ...owner, runId: row.processId, status });
  } catch (err) {
    console.warn(`[command-runs] closing the run ${row.processId} failed:`, err);
  }
}
