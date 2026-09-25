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
 * work still alive? Pure, like `woken-turn.ts`: the provider keeps the state on
 * the process and folds every stdout line in here.
 */

import { readBackgroundTasks, readParentToolUseId } from "./events";

/**
 * How long background work is believed without news. Claude Code defers its own
 * goal check-in by the same thirty minutes while background work runs
 * (`CLAUDE_CODE_GOAL_CHECKIN_MINUTES`, default 30, read in the 2.1.282 binary).
 *
 * Counted from the last line the CLI printed ABOUT that work, not from the
 * task's start: the agent 3019832f lost had been running for 23 minutes and
 * kept printing. A task nobody hears from for this long is presumed lost, so a
 * CLI that stops reporting cannot hold a chat forever.
 */
export const BACKGROUND_WORK_CAP_MS = 30 * 60_000;

export interface BackgroundWork {
  /** The last snapshot the CLI printed: task id to what it is. */
  tasks: ReadonlyMap<string, { type: string; description: string }>;
  /** When the CLI last printed a line about background work. */
  lastSignalAt: number;
}

/**
 * Fold one stdout line into a session's background work.
 *
 * A `background_tasks_changed` snapshot replaces the set. Any other line from
 * the work itself, `system/task_*` or a subagent's line, is news that it is
 * still going and moves `lastSignalAt`. Everything else returns `prev`
 * unchanged, so the caller can assign the result on every line.
 */
export function noteBackgroundLine(
  prev: BackgroundWork | undefined,
  event: unknown,
  now: number,
): BackgroundWork | undefined {
  const snapshot = readBackgroundTasks(event);
  if (snapshot) {
    return {
      tasks: new Map(snapshot.map((t) => [t.id, { type: t.type, description: t.description }])),
      lastSignalAt: now,
    };
  }
  if (!prev || prev.tasks.size === 0) return prev;
  return isBackgroundSignal(event) ? { tasks: prev.tasks, lastSignalAt: now } : prev;
}

/** A line the background work printed about itself. */
function isBackgroundSignal(event: unknown): boolean {
  if (readParentToolUseId(event) !== null) return true;
  const e = event as { type?: unknown; subtype?: unknown } | null;
  return e?.type === "system" && typeof e.subtype === "string" && e.subtype.startsWith("task_");
}

/** Is there background work alive, as of `now`? Past the cap it is presumed lost. */
export function isBackgroundWorkAlive(work: BackgroundWork | undefined, now: number): boolean {
  return !!work && work.tasks.size > 0 && now - work.lastSignalAt < BACKGROUND_WORK_CAP_MS;
}
