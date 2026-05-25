/**
 * master-proposals — pure helpers mapping parsed `## Next` proposals to
 * persistent kanban task rows (see refactor-master-into-kanban, AD-3/AD-4).
 *
 * Side-effect-free so the id/status/ref logic is unit-testable with `bun:test`.
 * The actual DB upsert + task_events write + WS broadcast live in the route.
 *
 * A "proposal card" is a `tasks` row with a non-null `claude_task_id`. We do
 * NOT add a kanban status: the existing CHECK is (backlog,todo,in_progress,
 * review,done), so APRI maps to `todo` (actionable) and COMPLETA to `done`
 * (resolved, reversible). The client styles claude_task_id rows distinctly.
 */

import { createHash } from "node:crypto";
import type { ProposalVerb } from "./master-next-parser";

/** Synthetic board id for proposals whose session has no project (e.g. a
 *  standalone claude-code terminal). Satisfies tasks.project_id NOT NULL and
 *  surfaces in the cross-project AllBoardsPane. */
export const GLOBAL_BOARD_ID = "master-global";

/** A session ref is a real topic (FK-valid for assigned_topic_id) unless it is
 *  a terminal pane ref like "terminal:<id>". */
export function isTopicRef(ref: string): boolean {
  return !!ref && !ref.startsWith("terminal:");
}

/** Kanban status for a proposal verb. */
export function proposalStatus(verb: ProposalVerb): "todo" | "done" {
  return verb === "completa" ? "done" : "todo";
}

/**
 * Stable id for a proposal, keyed on the session ref ONLY — one proposal card
 * per session. Re-emitting (APRI now, COMPLETA later, reworded reason) yields
 * the same id, so the upsert updates the SAME card in place rather than
 * spawning duplicates (enforced by the unique index idx_tasks_claude_task_id).
 * Card text and status track the latest emission; the verb drives the status.
 */
export function proposalTaskId(ref: string): string {
  return "mp-" + createHash("sha1").update(ref).digest("hex").slice(0, 16);
}
