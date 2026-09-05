/**
 * board-actions.ts — the quick replies the BOARD executes itself.
 *
 * Five labels (land, take over, requeue/promote/archive parked children) are
 * not an answer to the agent: they are an ORDER to the system, and the system
 * runs them with an UPDATE. They used to live inline in the review route, which
 * meant they only worked when they arrived through `POST …/review`. The very
 * same buttons are drawn by the drawer under a card that is still `in_progress`
 * (a question can now be answered in any column), and there the click goes to
 * the comments route: without this function it woke a whole agent turn to move
 * two cards, which is paying a model to do an UPDATE.
 *
 * The function OWNS no state: it takes the pieces of the route it needs, and
 * gives back the Response the route must return, or `null` when the text is not
 * one of the labels and the caller has to carry on as before.
 */
import { isArchiveParkedLabel, isLandActionLabel, isPromoteParkedLabel, isRequeueParkedLabel, isTakeOverParkedLabel } from "../../shared/board";
import type { ParkedChildrenDecision } from "../../shared/board";
import type { Actor, Task, UpdateTaskPatch } from "./tasks";

/** The slice of the task service these five actions touch. */
export type BoardActionService = {
  get(taskId: string, opts?: { projectId?: string }): { task: Task } | null | undefined;
  update(args: {
    taskId: string; actor: Actor; by: string; projectId?: string; patch: UpdateTaskPatch;
  }): Task;
  resolveParkedChildren(args: {
    taskId: string; decision: ParkedChildrenDecision; by?: string;
  }): { task: Task; children: Task[] } | null;
};

/** The slice of the dispatcher: only the door back into the queue. */
export type BoardActionDispatcher = { onEnterTodo(projectId: string, taskId: string): void };

export type BoardActionDeps = {
  svc: BoardActionService;
  dispatcher?: BoardActionDispatcher | null;
  broadcast(event: unknown): void;
  enqueueLand(projectId: string, taskId: string): unknown;
  /** The red-checks gate: a Response when it refuses, `null` when it lets through. */
  checksRedGate(projectId: string, taskId: string, force: unknown): Response | null;
  json(body: unknown, status?: number): Response;
  /** Who is pressing: the human identity of the surface. */
  by: string;
};

export type BoardActionTarget = { projectId: string; taskId: string };

/**
 * Runs the board action carried by `text`, if there is one.
 *
 * Returns the Response to send back, or `null` when the text is an ordinary
 * message and the caller keeps going (a reject that re-kicks the agent, a
 * comment that gets delivered).
 */
export function interceptBoardAction(
  deps: BoardActionDeps,
  target: BoardActionTarget,
  text: string | null | undefined,
  opts?: { force?: unknown },
): Response | null {
  const { svc, dispatcher, broadcast, json } = deps;
  const { projectId, taskId } = target;

  // THE THIRD WAY OUT OF THE PARKED-SUBTASK STALL, and it exists because the
  // first two could spin: the card goes back into a person's hands and the
  // children stay where they are. It does NOT go through `resolveParkedChildren`
  // (it resolves nothing) - it takes the task out of the agent's rotation, which
  // is what is needed once putting the children back in the queue has already
  // proved circular.
  if (isTakeOverParkedLabel(text)) {
    const taken = svc.update({
      taskId, actor: "human", by: deps.by,
      patch: { status: "in_progress", assignedTo: deps.by },
    });
    broadcast({ type: "task:updated", projectId, task: taken });
    return json(taken);
  }

  // THE TWO ANSWERS TO THE PARKED-SUBTASK STALL, plus the one that resolves the
  // children AND makes them servable: without `parent_task_id` the queue takes
  // them like any other card, while "put them back in the queue" leaves them
  // still in `todo` under a parent (the tick lists `rootsOnly`).
  if (isRequeueParkedLabel(text) || isPromoteParkedLabel(text) || isArchiveParkedLabel(text)) {
    const decision = isRequeueParkedLabel(text)
      ? "requeue" as const
      : isPromoteParkedLabel(text) ? "promote" as const : "archive" as const;
    const outcome = svc.resolveParkedChildren({ taskId, decision, by: deps.by });
    if (!outcome) {
      return json({
        error: "questo task non ha più sottotask parcheggiati: la domanda è già stata risolta", // allow-italian: message shown to whoever pressed, on the board
        code: "no_parked_children",
      }, 409);
    }
    broadcast({ type: "task:updated", projectId, task: outcome.task });
    // Children do not travel in the board feed (`rootsOnly`), but a drawer open
    // on the parent does: without this, whoever is watching sees the parent
    // restart and the subtasks still parked until a reload.
    for (const c of outcome.children) broadcast({ type: "task:updated", projectId, task: c });
    if (dispatcher && outcome.task.status === "todo") dispatcher.onEnterTodo(projectId, taskId);
    // PROMOTING IS QUEUEING, otherwise it is just removing a parent: a promoted
    // child is a card like the others, and somebody has to give it a turn now,
    // not the tick in ten minutes.
    if (dispatcher && decision === "promote") {
      for (const c of outcome.children) {
        if (c.status === "todo") dispatcher.onEnterTodo(projectId, c.id);
      }
    }
    return json(outcome.task);
  }

  // The «Landa su main» quick reply arrives carrying the button's text: without
  // this it was the gate's service door, the same merge with nobody reading the
  // checks. LANDING = merge THEN accept: the card stays in review and the land
  // closes it, when main confirms it, never a reject.
  if (isLandActionLabel(text)) {
    const gate = deps.checksRedGate(projectId, taskId, opts?.force);
    if (gate) return gate;
    const before = svc.get(taskId, { projectId })?.task;
    if (!before) return json({ error: "task not found", code: "not_found" }, 404);
    const ticket = deps.enqueueLand(projectId, taskId);
    const queued = svc.get(taskId, { projectId })?.task ?? before;
    return json({ ...queued, landing: ticket }, 202);
  }

  return null;
}
