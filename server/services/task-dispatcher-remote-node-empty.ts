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
import { namesMacOnlyPaths } from "./dispatch-overflow";
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
  // A card naming this Mac's own files comes back empty from ANY node, also one a person sent by hand: in review it
  // asked a choice nobody had to make (10/11, five cards twice in 2-5 min). It goes back here, pinned.
  const macOnly = namesMacOnlyPaths({ text: task.text, description: task.description ?? task.descriptionPreview });
  if (!task.overflowedAt && !macOnly) return false;
  if (!macOnly && pendingQuestionComment(deps.svc.get(task.id)?.comments ?? [])) return false;
  if (macOnly) {
    try {
      deps.releaseAndEmit({ taskId: task.id, requeue: true, rollbackAttempt: true });
      // THE ONE PLACE THE DISPATCHER ITSELF pins a card for good: every other
      // pin the dispatcher writes (and the overflow's own skip, below) carries
      // an expiry, because it answers a condition that can lift (a tool gets
      // installed, a node comes back online). A mac-only path does not: the
      // files it names live on this Mac and nowhere else, so there is no
      // future tick where sending this card elsewhere would work, and no
      // expiry to write that would ever be honest.
      //
      // NOT the one place in the whole codebase. A person can set the same
      // permanent shape by hand — the PATCH route (`task-patch.ts`), the
      // composer checkbox and the TaskDetail toggle all reach `tasks.ts`'s
      // `update`/`create`, which is where EVERY permanent pin (this one
      // included) gets its reason written to the thread (`stayLocalReason`,
      // or a generic line when nobody typed one) — see `scripts/stay-local-audit.ts`
      // for how that reason is told apart from this file's own.
      deps.emit(deps.svc.update({ taskId: task.id, actor: "agent", by: "dispatcher", patch: { machineId: null, stayLocal: true } }));
      deps.svc.addComment({
        taskId: task.id, author: "system", kind: "service",
        content: `La corsa su «${nodeName}» è finita senza nessun commit: la card usa file che stanno solo su questo Mac. La rimetto in coda qui, «solo Mac».`,
      });
      return true;
    } catch (err) {
      deps.log(`nodo: la card ${task.id} vuota non è tornata in coda`, err);
      return false;
    }
  }
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
