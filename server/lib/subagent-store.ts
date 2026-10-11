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
/**
 * Where the child runs: a Claude CLI in a PTY, or a chat of its own on the
 * Topics engine (openspec/changes/subagent-nativi). A native child has no
 * process: for it "retired" only means its turn is over and it holds no
 * slot.
 */
export type SubagentRuntime = "claude-code" | "topics";
/**
 * Why the child was born on its runtime: the call named it (`asked`), the
 * engine could not take it (`fallback`), or nothing was asked (`default`).
 * Only an `asked` CLI child stays on the CLI when resumed.
 */
export type SubagentRuntimeReason = "asked" | "fallback" | "default";

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
  runtime: SubagentRuntime;
  /** The child chat's session key (`topic:<id8>`): native children only. */
  sessionKey: string | null;
  /** The engine's tool names the profile allows, null = no restriction. Native children only. */
  tools: string[] | null;
}

type Db = Pick<Database, "query" | "run">;

interface RawRow {
  id: string; parent_session_key: string; name: string; model: string | null; agent_type: string | null;
  effort: string | null; prompt_snippet: string | null; cwd: string; branch: string | null;
  claude_session_id: string | null; state: SubagentState; turns_reported: number; reported_at: string | null;
  created_at: string; ended_at: string | null;
  runtime: string | null; session_key: string | null; tools: string | null;
}

function parseTools(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : null;
  } catch {
    return null;
  }
}

const fromRaw = (r: RawRow): SubagentRow => ({
  id: r.id, parentSessionKey: r.parent_session_key, name: r.name, model: r.model, agentType: r.agent_type,
  effort: r.effort, promptSnippet: r.prompt_snippet, cwd: r.cwd, branch: r.branch,
  claudeSessionId: r.claude_session_id, state: r.state, turnsReported: r.turns_reported,
  reportedAt: r.reported_at, createdAt: r.created_at, endedAt: r.ended_at,
  runtime: r.runtime === "topics" ? "topics" : "claude-code", sessionKey: r.session_key, tools: parseTools(r.tools),
});

const COLUMNS = "id, parent_session_key, name, model, agent_type, effort, prompt_snippet, cwd, branch, claude_session_id, state, turns_reported, reported_at, created_at, ended_at, runtime, session_key, tools";

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

export function insertSubagent(
  db: Db,
  row: Omit<SubagentRow, "state" | "turnsReported" | "reportedAt" | "endedAt" | "runtime" | "sessionKey" | "tools">
    & Partial<Pick<SubagentRow, "runtime" | "sessionKey" | "tools">> & { runtimeReason?: SubagentRuntimeReason },
): void {
  attempt(undefined, () => {
    db.run(
      `INSERT OR REPLACE INTO subagents (id, parent_session_key, name, model, agent_type, effort, prompt_snippet, cwd, branch, claude_session_id, state, turns_reported, created_at, runtime, session_key, tools)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?, ?, ?, ?)`,
      [row.id, row.parentSessionKey, row.name, row.model, row.agentType, row.effort, row.promptSnippet, row.cwd, row.branch, row.claudeSessionId, row.createdAt,
        row.runtime ?? "claude-code", row.sessionKey ?? null, row.tools ? JSON.stringify(row.tools) : null],
    );
  });
  // Its own statement: a database without the column still gets the row above.
  const reason = row.runtimeReason;
  if (reason) attempt(undefined, () => { db.run("UPDATE subagents SET runtime_reason = ? WHERE id = ?", [reason, row.id]); });
}

/** Why the child was born where it was; null for a row older than the column. */
export function subagentRuntimeReason(db: Db, id: string): SubagentRuntimeReason | null {
  return attempt(null, () => {
    const r = db.query("SELECT runtime_reason AS v FROM subagents WHERE id = ?").get(id) as { v: string | null } | null;
    return r?.v === "asked" || r?.v === "fallback" || r?.v === "default" ? r.v : null;
  });
}

/**
 * A CLI child moves to the engine on resume (subagent-nativi). The row is
 * UPDATED, never replaced: its turns already reported and its results still
 * pending belong to the same child, and a fresh row restarted the numbering
 * at turn 1, a key the dedup had already used (so every later result was lost).
 */
export function moveSubagentToEngine(db: Db, id: string, to: { sessionKey: string; tools: string[] | null; model: string | null }): void {
  attempt(undefined, () => {
    db.run(
      "UPDATE subagents SET runtime = 'topics', session_key = ?, tools = ?, model = COALESCE(?, model), state = 'running', ended_at = NULL WHERE id = ?",
      [to.sessionKey, to.tools ? JSON.stringify(to.tools) : null, to.model, id],
    );
  });
}

/** A person opened this child: it is theirs from now on, across restarts (SUBAGENT-21). */
export function markSubagentEngaged(db: Db, id: string, at = new Date().toISOString()): void {
  attempt(undefined, () => { db.run("UPDATE subagents SET engaged_at = COALESCE(engaged_at, ?) WHERE id = ?", [at, id]); });
}

export function isSubagentEngaged(db: Db, id: string): boolean {
  return attempt(false, () => {
    const r = db.query("SELECT engaged_at AS v FROM subagents WHERE id = ?").get(id) as { v: string | null } | null;
    return !!r?.v;
  });
}

/** The native child whose chat is this session, or null (a CLI child, a person's chat). */
export function getSubagentBySessionKey(db: Db, sessionKey: string): SubagentRow | null {
  return attempt(null, () => {
    const r = db.query(`SELECT ${COLUMNS} FROM subagents WHERE session_key = ?`).get(sessionKey) as RawRow | null;
    return r ? fromRaw(r) : null;
  });
}

/**
 * How many spawns sit above this session: 0 for a person's chat or terminal,
 * 1 for a child, 2 for a grandchild. It walks the rows, so a restart does not
 * reset it; a CLI child is keyed by its id, a native one by its chat's
 * session key.
 */
export function subagentDepth(db: Db, sessionKey: string): number {
  let depth = 0;
  const seen = new Set<string>();
  for (let key: string | undefined = sessionKey; key && !seen.has(key); ) {
    seen.add(key);
    const row: SubagentRow | null = getSubagent(db, key) ?? getSubagentBySessionKey(db, key);
    if (!row) break;
    depth++;
    key = row.parentSessionKey;
  }
  return depth;
}

/**
 * The session at the top of the spawn chain: the person's chat that started a
 * child, a grandchild, and so on. Returns `sessionKey` itself when it is not a
 * child. Used to put a child's browser into the window of the chat the person
 * is looking at, instead of a layout tab of its own for every child.
 */
export function rootSessionKeyOf(db: Db, sessionKey: string): string {
  let key = sessionKey;
  const seen = new Set<string>();
  while (!seen.has(key)) {
    seen.add(key);
    const row: SubagentRow | null = getSubagent(db, key) ?? getSubagentBySessionKey(db, key);
    if (!row?.parentSessionKey) break;
    key = row.parentSessionKey;
  }
  return key;
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

/**
 * A native child's turn reaches its parent: written once, by the turn's name
 * (the user row it answers). `false` = it was already reported, and this
 * second result goes nowhere.
 */
export function claimTurnReport(db: Db, id: string, turnId: string, status: string, at = new Date().toISOString()): boolean {
  return attempt(false, () => db.run(
    "INSERT OR IGNORE INTO subagent_reported_turns (subagent_id, turn_id, status, reported_at) VALUES (?, ?, ?, ?)",
    [id, turnId, status, at],
  ).changes > 0);
}

/** A native child's chat opened the turn `turnId` (its stream started): from now on it is a turn. */
export function recordTurnStarted(db: Db, id: string, turnId: string, at = new Date().toISOString()): void {
  attempt(undefined, () => {
    db.run("INSERT OR IGNORE INTO subagent_started_turns (subagent_id, turn_id, started_at) VALUES (?, ?, ?)", [id, turnId, at]);
  });
}

/** The last turn the child's chat opened and its parent never heard of, or null. */
export function lastUnreportedTurn(db: Db, id: string): string | null {
  return attempt(null, () => {
    const last = db.query("SELECT turn_id FROM subagent_started_turns WHERE subagent_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(id) as { turn_id: string } | null;
    return last && !turnWasReported(db, id, last.turn_id) ? last.turn_id : null;
  });
}

/** Was this turn of the child reported already? */
export function turnWasReported(db: Db, id: string, turnId: string): boolean {
  return attempt(false, () => db.query("SELECT 1 FROM subagent_reported_turns WHERE subagent_id = ? AND turn_id = ?").get(id, turnId) != null);
}

/** How the child's last reported turn ended, or null when none is on record. */
export function lastReportedTurnStatus(db: Db, id: string): string | null {
  return attempt(null, () => (db.query("SELECT status FROM subagent_reported_turns WHERE subagent_id = ? ORDER BY reported_at DESC, rowid DESC LIMIT 1").get(id) as { status: string } | null)?.status ?? null);
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
  // A native child's history is its chat: there is no transcript to lose.
  if (row.runtime !== "topics" && !row.claudeSessionId) return { ok: false, status: 410, reason: "the sub-agent has no session to resume: its transcript was never found" };
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
