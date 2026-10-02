/**
 * The life of `spawn_agent` children between their spawn and their end
 * (SUBAGENT-11 to 15): the turn each one is in, read from its transcript on a
 * tick; the result of every turn, recorded once and handed to a foreground
 * call or to the parent chat; the retirement of a finished child and the end
 * of one whose process went; the limits on how many may run.
 *
 * Out of `routes/terminal.ts` because it has a state of its own (the runtime
 * of each child, the dedup, the foreground holds) and nothing to do with
 * routing. What it needs of the terminal (the live sessions, the bridge-side
 * park, the transcript discovery, the roster broadcast) arrives through
 * `configureSubagentRuntime`, so this module does not import the router and
 * the dependency stays one-way. What a restart must not forget is on the
 * child's `subagents` row (`lib/subagent-store.ts`), not here.
 */
import fs from "fs";
import { getDatabase } from "../db";
import { warnThrottled } from "./warn-throttled";
import { claudeTranscriptPath } from "./claude-transcript-path";
import {
  childModel, emptyTally, endingChildTurn, forgetTurns, pendingTallyTurns, resultKey, tallyLines, tallyTurnDurationMs, turnDurationMs,
  type SubAgentEnding, type SubAgentOutcome, type SubAgentResult, type TranscriptTally,
} from "./subagent-result";
import {
  SUBAGENT_RETIRE_IDLE_MS, SUBAGENT_RESUME_WINDOW_MS, addPendingResult, allPendingResults, clearPendingResult, getSubagent,
  markTurnReported, parentHasPendingResults, runningSubagents, setSubagentState, type SubagentRow,
} from "./subagent-store";
import type { SubAgentExitInfo } from "../routes/subagent-exit";
import { parseJsonlLine, splitJsonlChunk } from "./claude-session-state";
import { openTail, readTail, type FileTail } from "./file-tail";
import { tryGetProvider } from "../providers";

/** What this module reads of a terminal session: a live child, or one rebuilt from its row. */
export interface ChildRef {
  id: string;
  name: string;
  cwd: string;
  createdAt: string;
  claudeSessionId?: string;
  parentSessionKey?: string;
  spawnPromptSnippet?: string;
}

/** What the terminal router lends this module. */
export interface SubagentRuntimeDeps {
  /** The live sessions that are sub-agents. */
  liveChildren(): ChildRef[];
  /** Adopt the child's real transcript id (it mutates `claudeSessionId`). */
  adoptTranscriptId(child: ChildRef): void;
  /** The child's transcript lines, or null when none can be found. */
  readLines(child: ChildRef): Promise<string[] | null>;
  branchOf(cwd: string): string | null;
  /**
   * Close the child's PTY through the idle park's gates; true when it went.
   * `beforeKill` runs once the gates said yes and before the kill, so a
   * refusal writes nothing.
   */
  park(child: ChildRef, idleMs: number, beforeKill: () => void): boolean;
  /** Push the roster again: a child's phase changed. */
  broadcast(): void;
  /** Where a result for a chat parent goes (`setSubAgentExitHandler`). */
  handler(): ((info: SubAgentExitInfo) => void) | null;
}

let configured: SubagentRuntimeDeps | null = null;
const deps = (): SubagentRuntimeDeps => {
  if (!configured) throw new Error("subagent-runtime: configureSubagentRuntime was never called");
  return configured;
};
export function configureSubagentRuntime(d: SubagentRuntimeDeps): void {
  configured = d;
}

/** Max spawned-agent ancestry depth (a top-level orchestrator's child = 1). */
export const MAX_AGENT_DEPTH = 3;
/** Max live children per parent — a runaway parent can't fork unbounded PTYs. */
export const MAX_CHILDREN_PER_PARENT = 5;

/**
 * What the server tracks of a live child between two looks at its transcript.
 * In memory on purpose: everything a restart must not forget is on the
 * child's `subagents` row (`lib/subagent-store.ts`).
 */
interface ChildRuntime {
  /** When the prompt (or a resumed input) was seeded: the 60 s of `undelivered` count from here. */
  seededAt: number | null;
  undeliveredReported: boolean;
  /** Transcript size at the last look: an unchanged file is not read again. */
  lastSize: number;
  phase: SubAgentPhase;
  /** The transcript as far as it was read: a look reads only what was appended since. */
  transcript: TranscriptCursor | null;
}

/** Where the last look at a child's transcript stopped, and what it had folded. */
interface TranscriptCursor {
  path: string;
  /** The file read: another one under the same name is read from its top. */
  ino: number;
  tail: FileTail;
  /** A last line still being written: it is folded once it ends. */
  partial: string;
  tally: TranscriptTally;
}
/** The live state of a child as its strip and card show it (SUBAGENT-16). */
export type SubAgentPhase = 'waiting-prompt' | 'working' | 'finished';
const childRuntime = new Map<string, ChildRuntime>();
/** Delivered results, per `resultKey`: the per-turn dedup of this process. */
const deliveredResultKeys = new Set<string>();

export function runtimeOf(id: string): ChildRuntime {
  let rt = childRuntime.get(id);
  if (!rt) {
    rt = { seededAt: null, undeliveredReported: false, lastSize: -1, phase: 'waiting-prompt', transcript: null };
    childRuntime.set(id, rt);
  }
  return rt;
}

/**
 * A foreground `spawn_agent` (SUBAGENT-13) holds its child's results until the
 * call collects them, so the same turn does not ALSO wake the parent. The hold
 * ends when the call says so (`release`) or at its deadline; whatever it still
 * holds then goes the ordinary way, so a caller that died mid-wait loses
 * nothing.
 */
interface ForegroundHold {
  /** The session whose call is waiting: its own wait, not a stall (`awaitsForegroundChild`). */
  parentSessionKey: string;
  until: number;
  held: SubAgentResult[];
  waiters: Set<(r: SubAgentResult) => void>;
  timer: ReturnType<typeof setTimeout>;
}
const foregroundHolds = new Map<string, ForegroundHold>();
/** How long a foreground call waits for its child's first result. */
export const FOREGROUND_WAIT_MS = 10 * 60_000;

export function holdForeground(id: string, parentSessionKey: string, ms: number): void {
  const prev = foregroundHolds.get(id);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => releaseForeground(id), ms);
  timer.unref?.();
  foregroundHolds.set(id, { parentSessionKey, until: Date.now() + ms, held: prev?.held ?? [], waiters: prev?.waiters ?? new Set(), timer });
}

/**
 * A foreground `spawn_agent` of this session is waiting for its child: the
 * session is quiet because Topics runs that child, so the stall watch holds
 * as it does for our own checks. Bounded by the hold's own deadline.
 */
export function awaitsForegroundChild(parentSessionKey: string): boolean {
  for (const hold of foregroundHolds.values()) if (hold.parentSessionKey === parentSessionKey) return true;
  return false;
}

export function releaseForeground(id: string): void {
  const hold = foregroundHolds.get(id);
  if (!hold) return;
  clearTimeout(hold.timer);
  foregroundHolds.delete(id);
  for (const r of hold.held) deliverChildResult(r, null);
}

/** What a child's transcript says of a turn, when it could be read. */
interface TurnFacts { model: string | null; durationMs: number | null }

/** The parent's chosen name, the launch and the branch of a child, from its row first. */
function resultOf(child: Pick<ChildRef, 'id' | 'name' | 'cwd'>, row: SubagentRow | null, turn: number, outcome: SubAgentOutcome, facts: TurnFacts | null): SubAgentResult {
  return {
    ...outcome,
    agentId: child.id,
    name: row?.name ?? child.name,
    turn,
    model: facts?.model ?? row?.model ?? null,
    agentType: row?.agentType ?? null,
    durationMs: facts?.durationMs ?? null,
    cwd: child.cwd,
    branch: deps().branchOf(child.cwd) ?? row?.branch ?? null,
  };
}

/**
 * One result of one turn, recorded once: the dedup advances (in memory and on
 * the row), then a foreground call collects it or it goes to the parent.
 */
function emitChildResult(parentSessionKey: string, result: SubAgentResult, exitCode: number | null): void {
  const key = resultKey(result);
  if (deliveredResultKeys.has(key)) return;
  deliveredResultKeys.add(key);
  const db = getDatabase();
  if (result.status === 'undelivered') {
    runtimeOf(result.agentId).undeliveredReported = true;
    // Turn 0: the retire clock starts and the row remembers the report across
    // a restart, while turn 1 stays open for a prompt that lands after all.
    markTurnReported(db, result.agentId, 0);
  } else {
    markTurnReported(db, result.agentId, result.turn);
  }
  const rt = childRuntime.get(result.agentId);
  if (rt && result.status !== 'undelivered') {
    rt.phase = 'finished';
    // A look already in flight may have read the row before this report and
    // set the phase back: the next tick reads the file again and settles it.
    rt.lastSize = -1;
  }
  deps().broadcast();
  const hold = foregroundHolds.get(result.agentId);
  if (hold) {
    if (hold.waiters.size) {
      for (const w of hold.waiters) w(result);
      hold.waiters.clear();
    } else {
      hold.held.push(result);
    }
    return;
  }
  deliverChildResult(result, exitCode, parentSessionKey);
}

/**
 * The result goes to the chat that spawned the child: written on the child's
 * row at once (so a restart cannot lose it while the parent's turn runs), then
 * handed to the topics router, which wakes the parent (SUBAGENT-12). A PTY
 * parent gets no push: it reads with `read_agent`, as the spawn answer says.
 */
function deliverChildResult(clean: SubAgentResult, exitCode: number | null, parentKey?: string): void {
  const db = getDatabase();
  const parentSessionKey = parentKey ?? getSubagent(db, clean.agentId)?.parentSessionKey;
  const handler = deps().handler();
  if (!parentSessionKey?.startsWith('topic:') || !handler) return;
  addPendingResult(db, clean.agentId, clean);
  try {
    handler({
      parentSessionKey, childId: clean.agentId, name: clean.name,
      outcome: { status: clean.status, partial: clean.partial, text: clean.text, ...(clean.reason ? { reason: clean.reason } : {}) },
      exitCode,
      // WORKTREE-14: a child that worked in a worktree of its own leaves the
      // parent nothing but a branch, so the report has to name it.
      branch: clean.branch,
      turn: clean.turn, model: clean.model, agentType: clean.agentType, durationMs: clean.durationMs, cwd: clean.cwd,
      settle: () => clearPendingResult(getDatabase(), clean.agentId, clean.turn, clean.status),
    });
  } catch (err) {
    console.warn(`[Terminal] subAgentExitHandler failed for ${clean.agentId}:`, err);
  }
}

/** The results a restart found still owed to their parent chats, sent again. */
function redeliverPendingResults(): void {
  for (const { row, results } of allPendingResults(getDatabase())) {
    for (const r of results) {
      // Already delivered by this process: the handler has it, and settles it.
      if (deliveredResultKeys.has(resultKey(r))) continue;
      deliveredResultKeys.add(resultKey(r));
      deliverChildResult(r, null, row.parentSessionKey);
    }
  }
}

/**
 * The child's transcript folded up to its end, reading only what was appended
 * since the last look: a working child's file grows by megabytes, and reading
 * it whole every two seconds cost up to 141 ms of the main thread per child.
 * Synchronous on purpose, like the tail it uses: two looks in flight (the tick
 * and the `Stop` hook) cannot fold the same bytes twice. A file cut below
 * what was read, or another file under the same name, is read from its top.
 */
function foldTranscript(rt: ChildRuntime, path: string, stat: fs.Stats | null): TranscriptTally {
  let cur = rt.transcript;
  if (!cur || cur.path !== path || (stat && (stat.ino !== cur.ino || stat.size < cur.tail.offset))) {
    cur = rt.transcript = { path, ino: stat?.ino ?? 0, tail: openTail(path), partial: '', tally: emptyTally() };
  }
  if (!stat) return cur.tally;
  const { text } = readTail(cur.tail, Number.POSITIVE_INFINITY);
  if (!text) return cur.tally;
  const { lines, remainder } = splitJsonlChunk(cur.partial + text);
  cur.partial = remainder;
  tallyLines(cur.tally, lines);
  return cur.tally;
}

/**
 * Look at a live child's transcript and report the turns it has finished
 * (SUBAGENT-11). The process does not exit at the end of a turn, so this is
 * the only way the end is seen; the `Stop` hook only makes the look earlier.
 */
async function checkChildTurns(child: ChildRef): Promise<void> {
  const db = getDatabase();
  const row = getSubagent(db, child.id);
  if (!row || row.state !== 'running') return;
  const rt = runtimeOf(child.id);
  deps().adoptTranscriptId(child);
  if (!child.claudeSessionId) return;
  // After a restart this process never seeded the child: its prompt went in
  // at the spawn, and an `undelivered` already reported is on the row (turn
  // 0 with a report time). Without both, a seeding the restart cut was never
  // reported, and the child held its slot for good.
  const seededAt = rt.seededAt ?? (row.turnsReported === 0 ? Date.parse(row.createdAt) : null);
  const undeliveredReported = rt.undeliveredReported || (row.turnsReported === 0 && row.reportedAt != null);
  const path = claudeTranscriptPath(child.cwd, child.claudeSessionId);
  let stat: fs.Stats | null = null;
  try { stat = await fs.promises.stat(path); } catch { /* not written yet */ }
  const size = stat?.size ?? -1;
  // An unchanged file has nothing new, unless the `undelivered` clock is running.
  const undeliveredDue = seededAt != null && !undeliveredReported;
  if (size === rt.lastSize && !(undeliveredDue && rt.phase === 'waiting-prompt')) return;
  rt.lastSize = size;
  const tally = foldTranscript(rt, path, stat);
  forgetTurns(tally, row.turnsReported);
  const before = rt.phase;
  rt.phase = tally.prompts === 0 ? 'waiting-prompt' : tally.prompts <= row.turnsReported ? 'finished' : 'working';
  for (const { turn, outcome } of pendingTallyTurns(tally, {
    turnsReported: row.turnsReported, seededAt, now: Date.now(), undeliveredReported,
  })) {
    emitChildResult(row.parentSessionKey, resultOf(child, row, turn, outcome, { model: tally.model, durationMs: tallyTurnDurationMs(tally, turn) }), null);
  }
  if (rt.phase !== before) deps().broadcast();
}

/**
 * A finished child idle for 15 minutes after its report is retired (choice
 * 5): its PTY closed through the same gates as the idle park, its row kept as
 * `retired` with everything `send_to_agent` needs to bring it back. A child
 * reported `undelivered` is idle too: its prompt never arrived, and nothing
 * else would ever free its slot.
 */
function retireIdleChild(child: ChildRef, now = Date.now(), idleMs = SUBAGENT_RETIRE_IDLE_MS): boolean {
  const row = getSubagent(getDatabase(), child.id);
  if (!row || row.state !== 'running' || !row.reportedAt) return false;
  const phase = runtimeOf(child.id).phase;
  if (phase !== 'finished' && !(phase === 'waiting-prompt' && row.turnsReported === 0)) return false;
  if (now - Date.parse(row.reportedAt) < idleMs) return false;
  if (foregroundHolds.has(child.id)) return false;
  // Marked after the gates and BEFORE the kill: the exit frame then reads a
  // retirement, not an end, and a refusal leaves the row as it was.
  return deps().park(child, idleMs, () => setSubagentState(getDatabase(), child.id, 'retired'));
}

/** One pass over the live children: their turns, then the ones due for retirement. */
let childWatchRunning = false;
async function watchChildren(): Promise<void> {
  if (childWatchRunning) return;
  childWatchRunning = true;
  try {
    for (const child of deps().liveChildren()) {
      try {
        await checkChildTurns(child);
        retireIdleChild(child);
      } catch (err) {
        warnThrottled('subagent:watch', `[Terminal] sub-agent watch failed for ${child.id}:`, err);
      }
    }
  } finally {
    childWatchRunning = false;
  }
}

/**
 * Retire every live child due for it, now. The watch does it on its tick; a
 * test calls it with a clock moved forward instead of waiting 15 minutes.
 */
export function retireIdleSubAgents(opts: { now?: number; idleMs?: number } = {}): string[] {
  const retired: string[] = [];
  for (const child of deps().liveChildren()) {
    if (retireIdleChild(child, opts.now, opts.idleMs)) retired.push(child.id);
  }
  return retired;
}

/** Test seam: forget what this process remembers of its children, as a restart does. */
export function _forgetSubAgentMemory(): void {
  childRuntime.clear();
  deliveredResultKeys.clear();
  for (const id of [...foregroundHolds.keys()]) {
    clearTimeout(foregroundHolds.get(id)!.timer);
    foregroundHolds.delete(id);
  }
}

/** The `Stop` hook of a child's session: look at its transcript now, not at the next tick. */
export function noteSubAgentStopHook(claudeSessionId: string): void {
  for (const child of deps().liveChildren()) {
    if (child.claudeSessionId !== claudeSessionId) continue;
    const t = setTimeout(() => { void checkChildTurns(child).catch(() => {}); }, 300);
    t.unref?.();
  }
}

/** The lines of a just-ended child's transcript, re-read briefly for the flush lag at exit. */
async function settledChildLines(child: ChildRef, done: (lines: string[] | null) => boolean): Promise<string[] | null> {
  let lines: string[] | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 800 : 700));
    lines = await deps().readLines(child);
    if (done(lines)) break;
  }
  return lines;
}

/**
 * A child's process ended: stopped by its parent, its tab closed, swept, exited
 * by itself, or lost with its terminal. Its row records the end, and the turn
 * it was in is reported, unless it was already: an idle child stopped after
 * its report produces no second result (SUBAGENT-11). A retirement is not an
 * end. A Reload is not one either: the child comes back under the same id, so
 * its row stays `running` and the watch keeps what it knows of it, but the
 * turn it cut is reported as `stopped`.
 */
export function reportChildEnd(child: ChildRef, exitCode: number | null, ending: SubAgentEnding): void {
  if (!child.parentSessionKey) return;
  const parentSessionKey = child.parentSessionKey;
  const db = getDatabase();
  const row = getSubagent(db, child.id);
  if (row?.state === 'retired') return;
  const reloaded = ending === 'reloaded';
  if (row && !reloaded) setSubagentState(db, child.id, ending === 'lost' ? 'lost' : 'stopped');
  const rt = childRuntime.get(child.id);
  if (!reloaded) childRuntime.delete(child.id);
  void (async () => {
    const verdictOf = (lines: string[] | null) => {
      const latest = getSubagent(getDatabase(), child.id);
      return endingChildTurn(lines, {
        turnsReported: latest?.turnsReported ?? 0,
        // On the row too: a restart forgot what this process had reported.
        undeliveredReported: (rt?.undeliveredReported ?? false) || (latest?.turnsReported === 0 && latest.reportedAt != null),
        ending, exitCode,
      });
    };
    // Anything but `completed` is read again: a final record still in the
    // CLI's buffer would otherwise read as a cut turn.
    const lines = await settledChildLines(child, (l) => { const v = verdictOf(l); return !v || v.outcome.status === 'completed'; });
    const verdict = verdictOf(lines);
    if (!verdict) return;
    const facts = lines ? { model: childModel(lines), durationMs: turnDurationMs(lines, verdict.turn) } : null;
    emitChildResult(parentSessionKey, resultOf(child, getSubagent(getDatabase(), child.id), verdict.turn, verdict.outcome, facts), exitCode);
  })().catch((err) => console.warn(`[Terminal] reporting the end of ${child.id} failed:`, err));
}

/**
 * Children the database still calls `running` with no terminal behind them
 * after a restart: they were lost with it, and are reported so.
 */
function reportLostChildren(): void {
  const live = new Set(deps().liveChildren().map((c) => c.id));
  for (const row of runningSubagents(getDatabase())) {
    if (live.has(row.id)) continue;
    reportChildEnd({
      id: row.id, name: row.name, createdAt: row.createdAt, cwd: row.cwd,
      claudeSessionId: row.claudeSessionId ?? undefined, parentSessionKey: row.parentSessionKey,
      spawnPromptSnippet: row.promptSnippet ?? undefined,
    }, null, 'lost');
  }
}

/**
 * The dormant terminal rows of children that ended more than 24 hours ago:
 * nothing reaches them otherwise (one sat dormant for three weeks).
 */
function sweepDormantChildRows(now = Date.now()): void {
  try {
    const db = getDatabase();
    const rows = db.query("SELECT id, created_at FROM terminal_sessions WHERE parent_session_key IS NOT NULL AND status = 'dormant'").all() as Array<{ id: string; created_at: string | null }>;
    for (const r of rows) {
      const sub = getSubagent(db, r.id);
      const endedAt = sub?.endedAt ? Date.parse(sub.endedAt) : sub ? NaN : Date.parse(r.created_at ?? '');
      if (!Number.isFinite(endedAt) || now - endedAt <= SUBAGENT_RESUME_WINDOW_MS) continue;
      db.run("DELETE FROM terminal_sessions WHERE id = ?", [r.id]);
    }
  } catch (e) {
    warnThrottled('subagent:dormant-sweep', '[Terminal] sweeping old dormant sub-agent rows failed:', e);
  }
}


/** Max live sub-agents on the whole machine (choice 4): every child is one more Claude CLI in RAM. */
const MAX_LIVE_SUBAGENTS = 6;

/**
 * Why a new child of `parentKey` cannot start, or null (SUBAGENT-15). Counted
 * from the `running` rows, which a restart does not reset, together with the
 * live map for children born before the table; a retired child holds no slot.
 */
export function subagentLimitRefusal(parentKey: string, live: { depth: number; childIds: readonly string[] }): string | null {
  const db = getDatabase();
  // Depth: the in-memory walk, or the persisted one when the map was reset.
  let rowDepth = 0;
  const seen = new Set<string>();
  for (let key: string | undefined = parentKey; key && !seen.has(key); ) {
    seen.add(key);
    const row = getSubagent(db, key);
    if (!row) break;
    rowDepth++;
    key = row.parentSessionKey;
  }
  if (Math.max(live.depth, rowDepth) + 1 > MAX_AGENT_DEPTH) {
    return `sub-agent depth limit (${MAX_AGENT_DEPTH}) reached`;
  }
  const mine = new Set([...runningSubagents(db, parentKey).map((r) => r.id), ...live.childIds]);
  if (mine.size >= MAX_CHILDREN_PER_PARENT) return `max ${MAX_CHILDREN_PER_PARENT} live sub-agents per session`;
  const all = runningSubagents(db);
  if (all.length >= MAX_LIVE_SUBAGENTS) {
    const holders = all.map((r) => `"${r.name}" (${r.parentSessionKey})`).join(", ");
    return `machine-wide limit of ${MAX_LIVE_SUBAGENTS} live sub-agents reached; holding the slots: ${holders}. Stop one with stop_agent, or wait for one to finish.`;
  }
  return null;
}


/**
 * The model a chat parent runs on: its pin, or what its provider starts a
 * turn with now (for Claude Code, the Settings model). Read the way the
 * context ring reads it (`routes/context.ts`).
 */
export function chatParentModel(topic: { model?: string | null; provider?: string | null }): string | null {
  if (topic.model) return topic.model;
  try { return tryGetProvider(topic.provider ?? undefined)?.defaultModel?.() ?? null; } catch { return null; }
}

/** The model of a Claude PTY parent: `message.model` of the last assistant record of its transcript. */
export function parentTranscriptModel(parent: Pick<ChildRef, 'cwd' | 'claudeSessionId'> | undefined): string | null {
  if (!parent?.claudeSessionId) return null;
  try {
    const lines = fs.readFileSync(claudeTranscriptPath(parent.cwd, parent.claudeSessionId), "utf-8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes('"assistant"')) continue;
      try {
        const ev = JSON.parse(lines[i]!) as { type?: string; message?: { model?: unknown } };
        if (ev.type === "assistant" && typeof ev.message?.model === "string" && ev.message.model !== "<synthetic>") return ev.message.model;
      } catch { /* a partial line */ }
    }
  } catch { /* no transcript */ }
  return null;
}


/**
 * Once per process, after the roster is reconciled and a result handler is
 * wired: children the restart lost are reported, old dormant child rows go,
 * and results that were owed to their parent chats are sent again.
 */
let bootChildSweepDone = false;
export function bootChildSweep(): void {
  if (bootChildSweepDone || !deps().handler()) return;
  bootChildSweepDone = true;
  reportLostChildren();
  sweepDormantChildRows();
  redeliverPendingResults();
}


/**
 * A child of this parent will wake it (SUBAGENT-12): one of its turns is open
 * (a running child not yet seen finished counts), or a result of it has not
 * reached the chat yet. What a board card that ended its turn on a child
 * waits for, instead of being nudged (`awaitsSubagentWake`).
 */
export function subagentWakeOwed(parentSessionKey: string): boolean {
  const db = getDatabase();
  for (const row of runningSubagents(db, parentSessionKey)) {
    if (childPhase(row.id) !== 'finished') return true;
    if (foregroundHolds.get(row.id)?.held.length) return true;
  }
  return parentHasPendingResults(db, parentSessionKey);
}

/** The phase the roster shows for a live child, or null before the first look. */
export function childPhase(id: string): SubAgentPhase | null {
  return childRuntime.get(id)?.phase ?? null;
}

/** A child was just told something (its seed, or `send_to_agent`): its turn is open. */
export function noteChildSeeded(id: string, opts: { working?: boolean } = {}): void {
  const rt = runtimeOf(id);
  rt.seededAt = Date.now();
  if (opts.working) rt.phase = 'working';
}

/**
 * `send_to_agent` on a live child: a new turn is open, and the roster says so
 * now. The next look reads `working` too, the phase it already has, so it
 * pushes nothing: without this the strip said «finished its turn» for the
 * whole second turn.
 */
export function noteChildSteered(id: string): void {
  const rt = childRuntime.get(id);
  if (!rt) return;
  rt.phase = 'working';
  deps().broadcast();
}

/**
 * The foreground wait of one leg (SUBAGENT-13): a result the hold already
 * has, or the next one within `legMs`, or "running". `released` when there is
 * no hold (it ended, or the spawn was a background one).
 *
 * `signal` is the request's: a caller that walked away (a stopped turn) takes
 * nothing. Its leg leaves the hold, and a result that reached it anyway goes
 * back to the hold, where the caller's release or the deadline delivers it.
 */
export async function waitForegroundLeg(agentId: string, legMs: number, signal?: AbortSignal): Promise<{ status: 'done'; result: SubAgentResult } | { status: 'running' | 'released' }> {
  const hold = foregroundHolds.get(agentId);
  if (!hold) return { status: 'released' };
  if (signal?.aborted) return { status: 'running' };
  const held = hold.held.shift();
  if (held) {
    if (!hold.held.length) releaseForeground(agentId);
    return { status: 'done', result: held };
  }
  const got = await new Promise<SubAgentResult | null>((resolve) => {
    const done = (r: SubAgentResult | null) => {
      clearTimeout(t);
      hold.waiters.delete(w);
      signal?.removeEventListener('abort', gone);
      resolve(r);
    };
    const w = (r: SubAgentResult) => done(r);
    const gone = () => done(null);
    const t = setTimeout(gone, legMs);
    hold.waiters.add(w);
    signal?.addEventListener('abort', gone, { once: true });
  });
  if (!got) return { status: 'running' };
  if (signal?.aborted) {
    if (foregroundHolds.get(agentId) === hold) hold.held.unshift(got);
    else deliverChildResult(got, null);
    return { status: 'running' };
  }
  releaseForeground(agentId);
  return { status: 'done', result: got };
}

/** How often the live children's transcripts are looked at. */
const CHILD_WATCH_MS = 2_000;
let childWatchTimer: ReturnType<typeof setInterval> | null = null;
/** Start the watch, once for the process however many routers there are. */
export function startChildWatch(): void {
  if (childWatchTimer) return;
  childWatchTimer = setInterval(() => { void watchChildren(); }, CHILD_WATCH_MS);
  childWatchTimer.unref?.();
}

// ── read_agent: a child's output from its transcript ─────────────────────────

interface AgentReadEvent { type: 'assistant' | 'tool_use'; text?: string; name?: string; input?: unknown; }

/** Pull the visible text out of an assistant transcript line. */
function assistantTextFromRaw(raw: any): string { // allow-any: a transcript line parsed as JSON, read field by field
  const content = raw?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("");
  }
  return "";
}

/** Read a child's structured output from its durable .jsonl transcript (clean
 *  assistant text + tool calls, no ANSI/TUI noise), paging from a byte offset.
 *  Falls back to a raw scrollback scrape when the transcript hasn't been
 *  flushed yet (the first second of a session). */
export async function readAgentOutput(
  child: Pick<ChildRef, 'id' | 'cwd' | 'claudeSessionId'>,
  since: number,
  /** The raw scrollback, for the first second before the transcript exists. */
  terminalBuffer: (id: string) => Promise<string>,
): Promise<{ events: AgentReadEvent[]; nextOffset: number; source: "jsonl" | "buffer"; buffer?: string }> {
  if (child.claudeSessionId) {
    const path = claudeTranscriptPath(child.cwd, child.claudeSessionId);
    try {
      // Polled repeatedly by the MCP orchestrator (one poll per monitored
      // sub-agent) — async fs so growing transcripts never block the loop.
      const size = (await fs.promises.stat(path)).size;
      let start = Number.isFinite(since) && since >= 0 ? since : 0;
      if (start > size) start = 0; // file truncated/rotated — re-read from top
      if (start === size) return { events: [], nextOffset: size, source: "jsonl" };
      const fd = await fs.promises.open(path, "r");
      try {
        const len = size - start;
        const bytes = Buffer.alloc(len);
        await fd.read(bytes, 0, len, start);
        const chunk = bytes.toString("utf-8");
        const { lines, remainder } = splitJsonlChunk(chunk);
        // Re-read the partial last line next call by stopping the offset before it.
        const nextOffset = size - Buffer.byteLength(remainder, "utf-8");
        const events: AgentReadEvent[] = [];
        for (const line of lines) {
          const ev = parseJsonlLine(line);
          if (!ev) continue;
          if (ev.type === "assistant") {
            const text = assistantTextFromRaw(ev.raw);
            if (text) events.push({ type: "assistant", text });
          } else if (ev.type === "tool_use") {
            events.push({ type: "tool_use", name: ev.name, input: ev.input });
          }
          // user / tool_result / summary / other are intentionally skipped.
        }
        return { events, nextOffset, source: "jsonl" };
      } finally {
        await fd.close();
      }
    } catch {
      // No transcript yet → fall through to the raw buffer.
    }
  }
  const buffer = await terminalBuffer(child.id);
  return { events: [], nextOffset: Number.isFinite(since) ? since : 0, source: "buffer", buffer };
}

