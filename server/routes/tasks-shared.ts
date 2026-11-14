/**
 * Pieces of the tasks routes that more than one sibling module needs: error codes, the review-ready edge, process stop, server repo check.
 */
import { STAGE_AI_REVIEW, awaitsHuman } from "../../shared/workflow";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { isThreadSpeech, pendingQuestion, type PendingQuestionComment } from "../../shared/board";
import { commentAsksHuman } from "../services/tasks";
import type { TasksRouterOpts } from "./tasks-opts";

export const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  invalid_input: 400,
  invalid_transition: 400,
  agent_cannot_complete: 409,
  open_subtasks: 409,
  review_needs_summary: 409,
  // The two gates of a board workflow (shared/workflow.ts): closing an AI
  // review without the proof, reaching Human review without the question.
  // State refusals like the one above, not permissions.
  ai_review_needs_proof: 409,
  human_review_needs_ask: 409,
  // A card the board ALREADY labelled `visibile` has a surface someone will
  // look at, so it delivers with a preview. 409 like the other review gates:
  // the delivery is refused for its state, not for a missing permission.
  review_needs_preview: 409,
  // The task was taken away from the agent (park/requeue): 409 like the other
  // ownership refusals, not 403. This is not a permissions problem, it is a
  // state that changed underneath in the meantime.
  task_not_yours: 409,
  // The card was closed by a human: reopening it would override that decision.
  // 409 like the other state refusals, not 403. It is not a missing permission,
  // it is a decision that already exists on the card.
  reopen_needs_human: 409,
  // 403 and not 409: here it is NOT a state that changed underneath, it is a
  // permission that does not exist and will not exist on the next attempt. An
  // agent does not mark its own work `invisibile`, full stop.
  label_forbidden: 403,
};

/**
 * Broadcast the dedicated "a task just ENTERED review" edge event. This is the
 * end-of-task signal the user asked for: it drives the OS banner (client
 * `useCompletionNotifier`) and the closed-app web-push (`push-triggers.ts`),
 * decoupled from the fragile session-idle inference. No-op unless the task
 * actually transitioned INTO review (prevStatus !== "review"), so re-emitting
 * `task:updated` for an already-in-review task (e.g. a new comment) never
 * re-notifies. Emitted IN ADDITION to `task:updated`, never instead of it.
 */
export function emitReviewReadyEdge(
  broadcast: (m: OutboundMessage) => void,
  projectId: string,
  task: { id: string; text: string; status: string; stage?: string | null } | undefined | null,
  prevStatus: string | undefined,
  reason?: string,
  /**
   * The task's thread, LAZY: called only when the edge actually fires. It
   * tells us whether the agent's last word is a question, because its options
   * become the banner's buttons. Lazy rather than an already-resolved
   * parameter because every PATCH of the task calls this function: reading the
   * thread on every priority save, for an edge that fires exactly once, would
   * be a query for nothing.
   */
  resolveComments?: () => readonly PendingQuestionComment[] | null | undefined,
  /**
   * The column the card was in. A card that moves from AI review to Human
   * review does not change status, and it is exactly the moment it starts
   * waiting on the person.
   */
  prevStage?: string | null,
): void {
  // Only what waits on a PERSON rings: a card in AI review goes back to whoever
  // opened it (`awaitsHuman`, rule of 28/10).
  const entered = !!task && task.status === "review" && (prevStatus !== "review" || prevStage === STAGE_AI_REVIEW);
  if (task && entered && awaitsHuman(task)) {
    let question: { text: string; options: string[] } | null = null;
    // Best-effort: a thread read that fails must not swallow the edge (a banner
    // without buttons is still far better than no banner at all).
    let isAsk = false;
    try {
      const comments = resolveComments?.();
      question = pendingQuestion(comments);
      // `question` also carries the options of a DELIVERY (the envelope tells
      // the agent to attach `options=["Landa su main"]` to every delivery, and
      // the server wraps them in the same ```question fence): it is not enough
      // to tell whether the agent's last word is asking something. `isAsk`
      // looks at the same last comment with `commentAsksHuman` (it reads the
      // OPTIONS, not the fence), so the banner can pick the right title without
      // losing the "Landa su main" button that lives in `question.options`.
      const speech = (comments ?? []).filter(isThreadSpeech);
      const last = speech[speech.length - 1];
      isAsk = commentAsksHuman(last?.content);
    } catch { question = null; isAsk = false; }
    broadcast({
      type: "task:review-ready",
      projectId,
      taskId: task.id,
      taskTitle: task.text || "Task",
      ...(reason ? { reason } : {}),
      // ALWAYS present, `null` included, and that is the point. The client
      // decides from here whether the banner carries "Approva" or the answers
      // to the question, and the two ends of the wire update separately (the
      // desktop shell ships its own client, the server is the daemon). With the
      // field OMITTED when there is no question, a new client on an old server
      // would read "no question" and put an "Approva" button on a task that is
      // waiting for an answer: one click, and the task is closed instead of
      // answered. An explicit `null` keeps "there is none" distinguishable from
      // "this server cannot say".
      question,
      isAsk,
    });
  }
}

// `pendingQuestion` lives in `shared/board.ts`: it has three readers on two
// sides of the wire (this emitter, the client's fallback on a server that does
// not send the field, and conceptually the card's quick-reply).
// Re-exported because this module's tests import it from here, where it was.
export { pendingQuestion };

export function requestCardProcessStop(opts: TasksRouterOpts | undefined, cardId: string): void {
  try {
    void Promise.resolve(opts?.stopCardProcesses?.(cardId)).catch((error) => {
      console.warn(`[processes] stop after card closure failed for ${cardId}:`, error);
    });
  } catch (error) {
    console.warn(`[processes] stop after card closure failed for ${cardId}:`, error);
  }
}

/** Is this repository the one this server runs from (and serves `public/` of)? */
export function isServerRepo(repoPath: string): boolean {
  try {
    return realpathSync(repoPath) === realpathSync(join(import.meta.dir, "..", ".."));
  } catch {
    return false;
  }
}

