/**
 * THE TRIAGE OF A CARD AT BIRTH, for the cards agents and schedules open.
 *
 * Measured on 2026-11-23: since 19/11 the board API created 87 of 121 cards, and
 * none of them went through the duplicate gate the MCP tools already had. The
 * same request came back as a new card every time, and numbered batches
 * ("Lavori programmati 3/8: ...") landed as N loose siblings with no card that
 * said what the batch was. Two rules live here, written once and called by every
 * door that opens cards for an agent:
 *
 *   1. A TWIN IS NOT A NEW CARD. A card that says the same as a card still open
 *      is not created: the open one gets a quiet note and is handed back.
 *   2. A SERIES HAS A MILESTONE. A card titled like a numbered batch is born
 *      under the card that names the batch, and when there is none yet and a
 *      sibling already exists the milestone is created and the siblings join it.
 *
 * People are never triaged: the composer already shows its own proposal
 * (`task-intake.ts`) and a person who opens a card means that card.
 */
import type { Database } from "bun:sqlite";
import { CREATED_BY_HUMAN } from "../../shared/created-by";
import { areSiblingsInSeries, isSeriesName, parseTaskSeries } from "../../shared/task-series";
import type { Neighbour } from "../../shared/task-similarity";
import type { Task, TaskService } from "./tasks";

/** Who wrote the notes and moves of this triage. */
const TRIAGE_AUTHOR = "card-triage";
/** The text a note carries of the request that arrived again: enough to read it, never a log. */
const REPEAT_BODY_CHARS = 2000;

type Broadcast = (event: { type: "task:created" | "task:updated"; projectId: string; task: Task }) => void;

export interface TriageDeps {
  svc: Pick<TaskService, "findDuplicates" | "get" | "addComment" | "list" | "update" | "create">;
  broadcast: Broadcast;
}

/**
 * The cards on the board that say the same as `text`, the gate every door shares (MCP tools, board API).
 * Done cards count (a closed card is still a decision somebody took). Two members of one numbered series
 * never count as twins: "3/8" and "4/8" are two jobs, however alike the rest of the title is.
 */
export function findCreationTwins(
  svc: Pick<TaskService, "findDuplicates">,
  projectId: string,
  text: string,
  limit = 3,
): Neighbour[] {
  return svc
    .findDuplicates({ projectId, text, limit, rootsOnly: true })
    .filter((near) => near.duplicate && !areSiblingsInSeries(text, near.task.text));
}

/**
 * The 409 body of a refused creation. The ids are not in the sentence: they ride in `duplicates[]` and the
 * client appends them. The sentence says what to DO and names the exact parameter, because an agent that
 * is only told "duplicate" rewrites the title until it passes.
 */
export function duplicateRejection(twins: readonly Neighbour[], commentTool: string): Record<string, unknown> {
  return {
    error: `a card already says it: "${twins[0]!.task.text}". Read that one and comment on it with ${commentTool}; if it really is another job, recreate with allow_duplicate: true.`,
    code: "duplicate",
    duplicates: twins.map((n) => ({ id: n.task.id, text: n.task.text, score: Number(n.score.toFixed(3)) })),
  };
}

/** A retry of a creation that already worked: its key is on a card, and `create` hands that card back. */
export function hasCardWithKey(db: Database, key: unknown): boolean {
  if (typeof key !== "string" || !key) return false;
  return !!db.prepare("SELECT 1 FROM tasks WHERE claude_task_id = ?").get(key);
}

/**
 * The board API for an agent or a schedule: when the card it asks for is already open, no new card.
 * The open twin gets one quiet note with the request that arrived again (never twice with the same words)
 * and is returned, so the caller reads `.id` as it always did. `null` = create normally: a person, a body
 * that opts out (`allowDuplicate`) or nests the card (`parentTaskId`: the steps of a job repeat by trade),
 * no twin, or a twin that already started (in progress, review, done).
 *
 * Only a twin that has not started absorbs the request. The callers write on the id they get back right
 * after (board-card and task-sync patch the description and the due date, jarvis-channels moves the card
 * to in progress and then review when its job ends), and a card some agent is working on must not be
 * rewritten or moved by another flow.
 */
export function mergeIntoOpenTwin(
  deps: TriageDeps,
  args: { projectId: string; createdBy: string; body: Record<string, unknown> | null | undefined },
): Task | null {
  const { projectId, createdBy, body } = args;
  if (createdBy === CREATED_BY_HUMAN) return null;
  if (body?.allowDuplicate === true || body?.allow_duplicate === true) return null;
  if (typeof body?.parentTaskId === "string" && body.parentTaskId) return null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return null;
  const { svc } = deps;
  // Eight and not three: the open twin may sit behind several closed ones.
  for (const near of findCreationTwins(svc, projectId, text, 8)) {
    const twin = svc.get(near.task.id, { projectId })?.task;
    if (!twin || (twin.status !== "backlog" && twin.status !== "todo")) continue;
    const description = typeof body?.description === "string" ? body.description.trim() : "";
    svc.addComment({
      taskId: twin.id, projectId, author: "system", quiet: true, once: true,
      content: `Stessa richiesta arrivata di nuovo da ${createdBy}: «${text}». Non ho aperto un'altra card.${description ? `\n\n${description.slice(0, REPEAT_BODY_CHARS)}` : ""}`, // allow-italian: board comment
    });
    const fresh = svc.get(twin.id, { projectId })?.task ?? twin;
    deps.broadcast({ type: "task:updated", projectId, task: fresh });
    return fresh;
  }
  return null;
}

/** What a card that is not a series member can be nested under: open, no review (a step added there re-kicks its agent). */
const canHoldSeries = (t: Task): boolean => t.status !== "done" && t.status !== "review";
/** A sibling that may move under the milestone: inert in backlog. Work that is queued, running or waiting for a person stays where its owner looks for it. */
const isInertSibling = (t: Task): boolean =>
  t.status === "backlog" && !t.assignedTopicId && t.dispatchState !== "working" && t.dispatchState !== "starting";

/**
 * A card titled like a numbered batch is grouped under the card that names the batch (`shared/task-series.ts`).
 *
 *   - a milestone with that exact name is open on the board: the new card joins it;
 *   - none, but another root card of the same series is open and inert: the milestone is created in backlog
 *     (a container with no attempts is never dispatched) and the new card and those siblings move under it;
 *   - otherwise nothing: a series of one is a card.
 *
 * Only a card born in backlog is grouped: a subtask is never dispatched on its own, so a card that was born
 * queued or running would drop out of the work it was made for. Returns the card as it is after the move;
 * a failure here never fails the creation.
 */
export function groupSeriesOnCreate(deps: TriageDeps, task: Task, createdBy: string | null): Task {
  if (createdBy === CREATED_BY_HUMAN || task.parentTaskId || task.status !== "backlog") return task;
  const series = parseTaskSeries(task.text);
  if (!series) return task;
  const { svc, broadcast } = deps;
  const { projectId } = task;
  try {
    const roots = svc.list({ scope: "project", projectId, rootsOnly: true }).filter((t) => t.id !== task.id);
    const existing = roots.find((t) => canHoldSeries(t) && isSeriesName(t.text, series)) ?? null;
    const siblings = existing ? [] : roots.filter((t) => isInertSibling(t) && parseTaskSeries(t.text)?.key === series.key);
    if (!existing && siblings.length === 0) return task;
    const holder = existing ?? svc.create({
      projectId, text: series.prefix, status: "backlog", createdSource: "triage:serie",
      description: `Card contenitore della serie ${series.prefix}: si chiude quando i figli sono done. Non spostarla in todo.`, // allow-italian: board card body
    });
    if (!existing) broadcast({ type: "task:created", projectId, task: holder });
    const nest = (child: Task): Task =>
      svc.update({ taskId: child.id, actor: "agent", by: TRIAGE_AUTHOR, projectId, patch: { parentTaskId: holder.id } });
    const nested = nest(task);
    for (const sibling of siblings) {
      try {
        const moved = nest(sibling);
        svc.addComment({
          taskId: sibling.id, projectId, author: "system", kind: "service", once: true,
          content: `Raggruppata sotto «${holder.text}»: la serie si segue dalla card contenitore.`, // allow-italian: board comment
        });
        broadcast({ type: "task:updated", projectId, task: moved });
      } catch (err) {
        // A sibling that started working since the read, or went away: it stays a root card.
        console.warn(`[card-triage] ${sibling.id} not grouped:`, err instanceof Error ? err.message : err);
      }
    }
    return nested;
  } catch (err) {
    console.warn(`[card-triage] series of ${task.id} not grouped:`, err instanceof Error ? err.message : err);
    return task;
  }
}
