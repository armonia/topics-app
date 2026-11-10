/**
 * A RUN ON THE OTHER MACHINE THAT PRODUCED NOTHING GOES BACK HOME.
 *
 * Measured 08/11: of the 17 deliveries from the PC waiting in review, 5 carried
 * zero commits of their own. The PC lacks what a lot of cards need (the GitHub
 * CLI, sqlite, the user's tool folder, the database), so the agent there could
 * not do the job, said so in the thread and handed over an empty branch. A
 * person was then asked to review nothing.
 *
 * The card goes back to the queue, pinned to this machine (`stay_local`) so the
 * overflow does not send it to the same place again, with its attempt refunded.
 * Only when the SYSTEM put it on the node (`overflowedAt`): a card a person sent
 * there by hand stays where they put it, with the reason on it.
 *
 * NOT when the run ended on a question (09/11): an agent that stopped to ask a
 * person a choice produced no commit because it was waiting, not because the
 * PC lacked a tool. Pinning it here would fill this machine's queue with cards
 * that run fine there; it goes to review with its buttons, like any question.
 */
import { pendingQuestionComment } from "../../shared/board";
import type { Task, TaskService } from "./tasks";

interface EmptyRunDeps {
  svc: TaskService;
  releaseAndEmit: (args: Parameters<TaskService["release"]>[0]) => Task;
  emit: (task: Task) => void;
  log: (msg: string, err?: unknown) => void;
}

/**
 * How long the pin holds. It answers to tools the node lacked, and those get
 * installed: on 10/11 five cards stayed on a Mac under its memory floor for
 * hours after gh and git reached the PC's agents. Six hours is a working
 * session: long enough not to bounce the same card back at once, short enough
 * that a fixed node gets it again the same day.
 */
export const EMPTY_RUN_PIN_MS = 6 * 60 * 60_000;

/** `true` = the card is back in the queue and the caller has nothing more to do. */
export function returnEmptyNodeRunToTodo(deps: EmptyRunDeps, task: Task, nodeName: string): boolean {
  if (!task.overflowedAt) return false;
  if (pendingQuestionComment(deps.svc.get(task.id)?.comments ?? [])) return false;
  try {
    deps.releaseAndEmit({ taskId: task.id, requeue: true, rollbackAttempt: true });
    // Skip THAT node, do not pin the card here: pinned, a Mac under its memory floor held it for hours while another
    // node was online (10/11: five cards in the memory queue, PC and Nodo cloud 1 free).
    const skip = task.machineId ? { machineId: task.machineId, until: new Date(Date.now() + EMPTY_RUN_PIN_MS).toISOString() } : null;
    deps.emit(deps.svc.update({ taskId: task.id, actor: "agent", by: "dispatcher", patch: skip
      ? { machineId: null, overflowSkip: skip }
      : { machineId: null, stayLocal: true, stayLocalUntil: new Date(Date.now() + EMPTY_RUN_PIN_MS).toISOString() } }));
    deps.svc.addComment({
      taskId: task.id, author: "system", kind: "service",
      content:
        `La corsa su «${nodeName}» è finita senza nessun commit: lì mancano strumenti che questa card usa. ` +
        "La rimetto in coda: per 6 ore non torna lì, ma se il Mac è pieno può andare su un'altra macchina.",
    });
    return true;
  } catch (err) {
    deps.log(`nodo: la card ${task.id} vuota non è tornata in coda`, err);
    return false;
  }
}
