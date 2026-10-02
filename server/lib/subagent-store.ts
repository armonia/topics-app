/**
 * The `subagents` table (migration 20261001203100): one row per `spawn_agent`
 * child, written by the terminal router and read by the limits, the resume and
 * the result delivery. Every statement lives here, so the state machine of a
 * child is readable in one place:
 *
 *   running ──(idle 15 min after its report)──> retired
 *   running ──(stop_agent, tab closed, sweep, exit)──> stopped
 *   running ──(PTY gone without an exit frame)──> lost
 *   retired | stopped | lost ──(send_to_agent within 24 h)──> running
 *
 * Only `running` holds a slot in the limits (SUBAGENT-15).
 */
import type { Database } from "bun:sqlite";
import type { SubAgentResult } from "./subagent-result";

export type SubagentState = "running" | "retired" | "stopped" | "lost";

/** After this long, an ended child leaves `list_agents` and can no longer be resumed (SUBAGENT-14). */
export const SUBAGENT_RESUME_WINDOW_MS = 24 * 60 * 60_000;
/** A finished child idle this long after its report is retired (choice 5). */
export const SUBAGENT_RETIRE_IDLE_MS = 15 * 60_000;

export interface SubagentRow {
  id: string;
  parentSessionKey: string;
  name: string;
  model: string | null;
  agentType: string | null;
  effort: string | null;
  promptSnippet: string | null;
  cwd: string;
  branch: string | null;
  claudeSessionId: string | null;
  state: SubagentState;
  turnsReported: number;
  reportedAt: string | null;
  createdAt: string;
  endedAt: string | null;
}

type Db = Pick<Database, "query" | "run">;

interface RawRow {
  id: string; parent_session_key: string; name: string; model: string | null; agent_type: string | null;
  effort: string | null; prompt_snippet: string | null; cwd: string; branch: string | null;
  claude_session_id: string | null; state: SubagentState; turns_reported: number; reported_at: string | null;
  created_at: string; ended_at: string | null;
}

const fromRaw = (r: RawRow): SubagentRow => ({
  id: r.id, parentSessionKey: r.parent_session_key, name: r.name, model: r.model, agentType: r.agent_type,
  effort: r.effort, promptSnippet: r.prompt_snippet, cwd: r.cwd, branch: r.branch,
  claudeSessionId: r.claude_session_id, state: r.state, turnsReported: r.turns_reported,
  reportedAt: r.reported_at, createdAt: r.created_at, endedAt: r.ended_at,
});

const COLUMNS = "id, parent_session_key, name, model, agent_type, effort, prompt_snippet, cwd, branch, claude_session_id, state, turns_reported, reported_at, created_at, ended_at";

/**
 * Every read and write is best-effort: a database without the table (an old
 * test schema, a migration not yet applied) must never stop a terminal from
 * opening. The callers fall back to what they did before the table existed.
 */
function attempt<T>(fallback: T, fn: () => T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function insertSubagent(db: Db, row: Omit<SubagentRow, "state" | "turnsReported" | "reportedAt" | "endedAt">): void {
  attempt(undefined, () => {
    db.run(
      `INSERT OR REPLACE INTO subagents (id, parent_session_key, name, model, agent_type, effort, prompt_snippet, cwd, branch, claude_session_id, state, turns_reported, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?)`,
      [row.id, row.parentSessionKey, row.name, row.model, row.agentType, row.effort, row.promptSnippet, row.cwd, row.branch, row.claudeSessionId, row.createdAt],
    );
  });
}

export function getSubagent(db: Db, id: string): SubagentRow | null {
  return attempt(null, () => {
    const r = db.query(`SELECT ${COLUMNS} FROM subagents WHERE id = ?`).get(id) as RawRow | null;
    return r ? fromRaw(r) : null;
  });
}

export function setSubagentState(db: Db, id: string, state: SubagentState, at = new Date().toISOString()): void {
  attempt(undefined, () => {
    db.run("UPDATE subagents SET state = ?, ended_at = CASE WHEN ? = 'running' THEN NULL ELSE ? END WHERE id = ?", [state, state, at, id]);
  });
}

export function setSubagentSessionId(db: Db, id: string, claudeSessionId: string): void {
  attempt(undefined, () => {
    db.run("UPDATE subagents SET claude_session_id = ? WHERE id = ?", [claudeSessionId, id]);
  });
}

/** A turn was reported: the dedup advances and the retire clock starts. */
export function markTurnReported(db: Db, id: string, turn: number, at = new Date().toISOString()): void {
  attempt(undefined, () => {
    db.run("UPDATE subagents SET turns_reported = MAX(turns_reported, ?), reported_at = ? WHERE id = ?", [turn, at, id]);
  });
}

/** Running children: of one parent, or of the whole machine. */
export function runningSubagents(db: Db, parentSessionKey?: string): SubagentRow[] {
  return attempt([], () => {
    const rows = parentSessionKey
      ? db.query(`SELECT ${COLUMNS} FROM subagents WHERE state = 'running' AND parent_session_key = ? ORDER BY created_at`).all(parentSessionKey)
      : db.query(`SELECT ${COLUMNS} FROM subagents WHERE state = 'running' ORDER BY created_at`).all();
    return (rows as RawRow[]).map(fromRaw);
  });
}

/** A parent's children that ended within the resume window, newest first. */
export function endedSubagents(db: Db, parentSessionKey: string, now = Date.now()): SubagentRow[] {
  return attempt([], () => {
    const since = new Date(now - SUBAGENT_RESUME_WINDOW_MS).toISOString();
    const rows = db.query(
      `SELECT ${COLUMNS} FROM subagents WHERE parent_session_key = ? AND state != 'running' AND ended_at >= ? ORDER BY ended_at DESC`,
    ).all(parentSessionKey, since) as RawRow[];
    return rows.map(fromRaw);
  });
}

/** Can this ended child still be resumed, and if not, why. */
export function resumeVerdict(row: SubagentRow, now = Date.now()): { ok: true } | { ok: false; status: 409 | 410; reason: string } {
  if (row.state === "running") return { ok: false, status: 409, reason: "the sub-agent is running" };
  if (!row.claudeSessionId) return { ok: false, status: 410, reason: "the sub-agent has no session to resume: its transcript was never found" };
  const endedAt = row.endedAt ? Date.parse(row.endedAt) : NaN;
  if (Number.isFinite(endedAt) && now - endedAt > SUBAGENT_RESUME_WINDOW_MS) {
    return { ok: false, status: 410, reason: `the sub-agent ended more than 24 hours ago (${row.endedAt}); its transcript is still on disk, spawn a new one to continue` };
  }
  return { ok: true };
}

// ── Results not yet delivered to the parent chat ─────────────────────────────

export function addPendingResult(db: Db, id: string, result: SubAgentResult): void {
  attempt(undefined, () => {
    const prev = pendingResultsOf(db, id).filter((r) => !(r.turn === result.turn && r.status === result.status));
    db.run("UPDATE subagents SET pending_results = ? WHERE id = ?", [JSON.stringify([...prev, result]), id]);
  });
}

export function clearPendingResult(db: Db, id: string, turn: number, status: string): void {
  attempt(undefined, () => {
    const rest = pendingResultsOf(db, id).filter((r) => !(r.turn === turn && r.status === status));
    db.run("UPDATE subagents SET pending_results = ? WHERE id = ?", [rest.length ? JSON.stringify(rest) : null, id]);
  });
}

export function pendingResultsOf(db: Db, id: string): SubAgentResult[] {
  return attempt([], () => {
    const r = db.query("SELECT pending_results FROM subagents WHERE id = ?").get(id) as { pending_results: string | null } | null;
    const parsed: unknown = r?.pending_results ? JSON.parse(r.pending_results) : [];
    return Array.isArray(parsed) ? (parsed as SubAgentResult[]) : [];
  });
}

/** A result of one of this parent's children is still on its way to the chat. */
export function parentHasPendingResults(db: Db, parentSessionKey: string): boolean {
  return attempt(false, () => !!db.query("SELECT 1 FROM subagents WHERE parent_session_key = ? AND pending_results IS NOT NULL LIMIT 1").get(parentSessionKey));
}

/** Every result a restart found still owed to a parent chat. */
export function allPendingResults(db: Db): Array<{ row: SubagentRow; results: SubAgentResult[] }> {
  return attempt([], () => {
    const rows = db.query(`SELECT ${COLUMNS} FROM subagents WHERE pending_results IS NOT NULL`).all() as RawRow[];
    return rows.map((r) => ({ row: fromRaw(r), results: pendingResultsOf(db, r.id) })).filter((x) => x.results.length > 0);
  });
}
