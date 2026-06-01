/**
 * Locate a Claude Code session's transcript on disk.
 *
 * Claude Code stores each session's JSONL transcript under
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, where the cwd is
 * encoded by replacing every `/` and `.` with `-`.
 *
 * The transcript is the DURABLE record of a session: it survives server
 * restarts and outlives the `terminal_sessions` row. So "is this dormant
 * claude session still revivable?" reduces to "does its transcript exist?" —
 * which is exactly what the reaper/reconcile needs to decide whether a row is
 * worth keeping (resumable) or truly dead.
 */
import { homedir } from "os";
import { join } from "path";

/** Encode a cwd the way Claude Code names its projects directory. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** Absolute path to a session's transcript JSONL (may or may not exist). */
export function claudeTranscriptPath(cwd: string, sessionId: string): string {
  return join(homedir(), ".claude", "projects", claudeProjectDirName(cwd), `${sessionId}.jsonl`);
}
