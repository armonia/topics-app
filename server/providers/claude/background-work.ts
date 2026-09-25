/**
 * THE WORK A CLOSED TURN LEAVES RUNNING.
 *
 * A turn that launched an Agent with `run_in_background`, a background Bash, a
 * Monitor or a Workflow ends with its `result` while that work goes on. The CLI
 * keeps the child alive, keeps printing the work's lines on the same stdout
 * (subagent lines with `parent_tool_use_id`, `system/task_*`,
 * `system/background_tasks_changed`), and wakes itself with a turn of its own
 * when a task reports back. Topics used to read none of it, and three clocks
 * took the silence of the closed turn for a chat with nothing to do:
 *
 *   - the stall judge SIGINTed chat 3019832f at 00:32:53Z on 25/09 while it
 *     waited for its own agent, and took the agent and four background
 *     commands with it (exit 137);
 *   - the goal loop nudged chat 7e9caa28 five times in 104 s on 24/09 while it
 *     waited for five of its own verifiers;
 *   - the idle reaper kills a child fifteen minutes after its last turn.
 *
 * This module is the one answer they all read: is this session's background
 * work still alive? The provider keeps one of these per process and folds every
 * stdout line into it; nothing here touches the process, the DB or a clock.
 */

import { readBackgroundTasks, readParentToolUseId } from "./events";

/**
 * How long background work is believed without news, by EVERY clock that can
 * kill the child: the stall judge, the idle reaper, the lifetime cap, a config
 * change. One bound on purpose: the verification of 25/09 found the judge on
 * thirty minutes while the others waited two hours, and the judge is the clock
 * that killed 3019832f.
 *
 * Claude Code never kills background work for silence (its thirty minutes are
 * the delay of a goal check-in, see `goal-continuation.ts`). This bound exists
 * only so that a task the CLI stopped reporting on cannot hold a CLI in RAM
 * forever on this Mac; when it fires, the reaper says so in the chat.
 */
export const BACKGROUND_WORK_CAP_MS = 2 * 60 * 60_000;

/**
 * How long a reported task keeps the session busy until the CLI wakes to answer
 * it. Recorded, the wake's `system/init` follows the notification by 0.3 to
 * 1.1 s; Claude Code re-checks its own goal after 60 s in the same state.
 */
export const WAKE_QUEUED_MS = 60_000;

/** What is known about one task between its start (or first listing) and its report. */
interface TaskFacts {
  /** The tool call that launched it: its subagent lines and heartbeats carry it as `parent_tool_use_id`. */
  toolUseId?: string;
  /** Owned by a subagent: its report wakes that subagent, not the model. */
  subagent: boolean;
  /** It was in a `background_tasks_changed` snapshot: a foreground Bash never is. */
  listed: boolean;
}

export interface BackgroundWork {
  /** The last snapshot the CLI printed, `ambient` tasks left out: task id to what it is. */
  tasks: Map<string, { type: string; description: string }>;
  /** When the CLI last printed something about that work. */
  lastSignalAt: number;
  /** Tasks seen starting or listed, until their `task_notification`. */
  facts: Map<string, TaskFacts>;
  /** A background task of the model reported and the wake answering it has not started yet. */
  wakeQueuedAt: number | null;
}

export function newBackgroundWork(): BackgroundWork {
  return { tasks: new Map(), lastSignalAt: 0, facts: new Map(), wakeQueuedAt: null };
}

/**
 * Fold one stdout line into a session's background work. `unattended` = no
 * turn of ours is registered on the session, so a `system/init` is the CLI
 * waking itself.
 *
 * News, which moves `lastSignalAt`, is any sign of a task in the last snapshot:
 * the snapshot itself, a `system/task_*` line about a listed task, a line whose
 * `parent_tool_use_id` is a listed task's tool call (a subagent talking, or a
 * `tool_progress` heartbeat), and a wake while tasks are listed. The wake is
 * the only sign a Monitor gives while it runs: its events arrive as turns of
 * the model with no `task_*` line (fixture, "Tick-2 fired."), and without
 * counting them a Monitor reporting every minute was presumed lost.
 */
export function noteBackgroundLine(
  work: BackgroundWork,
  event: unknown,
  now: number,
  opts: { unattended: boolean },
): void {
  const snapshot = readBackgroundTasks(event);
  if (snapshot) {
    const before = work.tasks;
    work.tasks = new Map();
    for (const t of snapshot) {
      // The CLI's own schema: "hosts should exclude them from activity
      // indicators" (dream, auto_mode_scan, fork workers, live watchers).
      if (t.ambient) continue;
      work.tasks.set(t.id, { type: t.type, description: t.description });
      const f = work.facts.get(t.id);
      if (f) f.listed = true;
      else work.facts.set(t.id, { subagent: false, listed: true });
    }
    // News only when OUR set changed: the CLI also re-emits the snapshot when
    // an ambient entry comes, goes or flips, and that says nothing about a lost
    // Bash listed next to it (review of 25/09).
    if (work.tasks.size !== before.size || [...work.tasks.keys()].some((id) => !before.has(id))) work.lastSignalAt = now;
    return;
  }
  const e = event as { type?: unknown; subtype?: unknown; task_id?: unknown; tool_use_id?: unknown; owned_by_subagent?: unknown } | null;
  if (e?.type === "system" && typeof e.subtype === "string") {
    const id = typeof e.task_id === "string" ? e.task_id : null;
    if (e.subtype === "init") {
      // A turn of the model starts: whatever was queued is being answered.
      work.wakeQueuedAt = null;
      if (opts.unattended && work.tasks.size > 0) work.lastSignalAt = now;
      return;
    }
    if (!id || !e.subtype.startsWith("task_")) return;
    if (e.subtype === "task_started") {
      const f = work.facts.get(id);
      work.facts.set(id, {
        toolUseId: typeof e.tool_use_id === "string" ? e.tool_use_id : f?.toolUseId,
        subagent: e.owned_by_subagent === true,
        listed: f?.listed ?? false,
      });
    }
    if (e.subtype === "task_notification") {
      const f = work.facts.get(id);
      work.facts.delete(id);
      // The model's own background task reported: the CLI wakes to answer it.
      // A foreground Bash reports too, and a subagent's task wakes the subagent.
      if (f?.listed && !f.subagent) work.wakeQueuedAt = now;
    }
    if (work.tasks.has(id)) work.lastSignalAt = now;
    return;
  }
  const parent = readParentToolUseId(event);
  if (parent !== null && work.tasks.size > 0) {
    for (const [id, f] of work.facts) {
      if (f.toolUseId === parent && work.tasks.has(id)) { work.lastSignalAt = now; return; }
    }
  }
}

/**
 * A replay folds every line with "now". The child's last write is the true age
 * of that news: a job silent for hours must not look fresh after every restart,
 * or no clock ever collects a lost one.
 */
export function datedByLastWrite(work: BackgroundWork, lastDataAt: number): void {
  if (lastDataAt < work.lastSignalAt) work.lastSignalAt = lastDataAt;
  if (work.wakeQueuedAt !== null && lastDataAt < work.wakeQueuedAt) work.wakeQueuedAt = lastDataAt;
}

/** A reported task whose wake has not started yet, within `WAKE_QUEUED_MS`. */
export function isWakeQueued(work: BackgroundWork | undefined, now: number): boolean {
  return !!work && work.wakeQueuedAt !== null && now - work.wakeQueuedAt < WAKE_QUEUED_MS;
}

/** Listed tasks with news within the bound. */
export function hasLiveTasks(work: BackgroundWork | undefined, now: number): boolean {
  return !!work && work.tasks.size > 0 && now - work.lastSignalAt < BACKGROUND_WORK_CAP_MS;
}

/** Is there background work alive, or a wake about to answer it, as of `now`? */
export function isBackgroundWorkAlive(work: BackgroundWork | undefined, now: number): boolean {
  return hasLiveTasks(work, now) || isWakeQueued(work, now);
}
