/**
 * A node's mirror card for a parent's spawn_agent child (openspec sottoagenti-nodo).
 *
 * `POST /api/nodes/runs` keys the mirror as `node-run:<originTaskId>`, and a child
 * always starts from its snapshot branch `topics-child-<originTaskId>`
 * (`subagent-remote-spawn.ts`). Both together mark it: a board card carried to a
 * node keeps its own delivery branch, never this one.
 *
 * A child weighs a few tens of MB and its parent is waiting on it, so the board's
 * heavy hold (one heavy turn takes the machine alone) does not apply to it. It
 * still takes a seat: the node's `slots` cap counts it like any other card.
 */
import type { Task } from "./task-shapes";

const NODE_RUN_KEY_PREFIX = "node-run:";
const CHILD_BRANCH_PREFIX = "topics-child-";

export function isNodeChildRun(task: Pick<Task, "claudeTaskId" | "baseBranch"> & Partial<Pick<Task, "dispatchWeight">>): boolean {
  // A child that turned out heavy (it runs the suite, it builds) is a heavy turn like any
  // other: letting it start beside the one in flight is exactly what the hold prevents.
  if (task.dispatchWeight === "heavy") return false;
  const key = task.claudeTaskId;
  if (!key || !key.startsWith(NODE_RUN_KEY_PREFIX)) return false;
  const originTaskId = key.slice(NODE_RUN_KEY_PREFIX.length);
  return originTaskId.length > 0 && task.baseBranch === CHILD_BRANCH_PREFIX + originTaskId;
}
