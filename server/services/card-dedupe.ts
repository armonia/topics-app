/**
 * One gate for "this request is already a card", shared by every create route.
 *
 * A request that repeats an OPEN card (same normalized title, or same
 * idempotency key) is not refused: it is absorbed. The existing card gets a
 * service comment carrying what the repeated request said, so nothing the
 * second author wrote is lost, and the caller gets that card back instead of a
 * second one. A merely SIMILAR title keeps the old answer (409 `duplicate`):
 * similarity is a judgement and the caller decides.
 */
import type { Task } from "./task-shapes";
import type { TaskService } from "./tasks-service-types";

export interface RepeatedRequest {
  projectId: string;
  text: string;
  description?: string | null;
  idempotencyKey?: string | null;
  /** Who repeated it, for the comment ("agent:session", "agent:coordinator"). */
  by: string;
  /** Only first-level cards collide; the steps of a checklist legitimately repeat. */
  rootsOnly?: boolean;
  /**
   * A FUTURE STEP IS A CARD WITH A REAL LINK (KANBAN-124). Absorbing a
   * repeated `create_task` used to drop this on the floor: the twin it
   * returned had no blocker, and the caller (MCP's `create_task`) still said
   * "created task" — the same 17-24/11 shape, a dependency that only ever
   * lived in a comment nobody re-reads (review feedback, 26/11, point 5).
   */
  blockedByTaskId?: string | null;
}

/** Longest slice of the repeated description copied into the comment. */
const REPEATED_DESCRIPTION_MAX_CHARS = 1500;

export type DedupeVerdict =
  | { kind: "absorbed"; task: Task }
  | { kind: "similar"; twins: Array<{ id: string; text: string; score: number }> }
  | { kind: "none" };

/** The service comment written on the card that absorbed a repeated request. */
export function repeatedRequestNote(req: Pick<RepeatedRequest, "text" | "description" | "by">): string {
  const description = (req.description ?? "").trim();
  const body = description.length > REPEATED_DESCRIPTION_MAX_CHARS
    ? `${description.slice(0, REPEATED_DESCRIPTION_MAX_CHARS)}…`
    : description;
  const lines = [`Richiesta ripetuta da ${req.by}: nessuna card nuova, il testo è qui.`, `Titolo: ${req.text.trim()}`];
  if (body) lines.push(`Descrizione: ${body}`);
  return lines.join("\n");
}

/**
 * Looks the request up on the board and, when an open card already says it,
 * writes the note on that card. `allowDuplicate` skips the whole gate, same as
 * before: an explicit override stays an explicit override.
 */
export function absorbRepeatedRequest(
  svc: Pick<TaskService, "findOpenTwin" | "findDuplicates" | "addComment" | "update">,
  req: RepeatedRequest,
  opts: { allowDuplicate?: boolean } = {},
): DedupeVerdict {
  if (opts.allowDuplicate) return { kind: "none" };
  const text = req.text.trim();
  if (!text && !req.idempotencyKey) return { kind: "none" };
  const twin = svc.findOpenTwin({
    projectId: req.projectId, text, idempotencyKey: req.idempotencyKey, rootsOnly: req.rootsOnly,
  });
  if (twin) {
    svc.addComment({
      // `once`: a caller retrying the very same call must not stack identical notes.
      taskId: twin.id, author: "system", kind: "service", projectId: req.projectId, once: true,
      content: repeatedRequestNote({ text, description: req.description, by: req.by }),
    });
    // The twin absorbed the request, but not the ONE thing that made this
    // request different from a plain repeat: who it is waiting on. Without
    // this the twin is dispatchable with no blocker at all, exactly the gap
    // this whole round of fixes is about (review feedback, 26/11, point 5).
    let patched = twin;
    if (req.blockedByTaskId && req.blockedByTaskId !== twin.blockedByTaskId) {
      patched = svc.update({
        taskId: twin.id, actor: "agent", by: req.by, projectId: req.projectId,
        patch: { blockedByTaskId: req.blockedByTaskId },
      });
    }
    return { kind: "absorbed", task: patched };
  }
  if (!text) return { kind: "none" };
  const near = svc
    .findDuplicates({ projectId: req.projectId, text, limit: 3, rootsOnly: req.rootsOnly })
    .filter((n) => n.duplicate);
  if (near.length === 0) return { kind: "none" };
  return {
    kind: "similar",
    twins: near.map((n) => ({ id: n.task.id, text: n.task.text, score: Number(n.score.toFixed(3)) })),
  };
}
