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
 */
import type { Task, TaskService } from "./tasks";

interface EmptyRunDeps {
  svc: TaskService;
  releaseAndEmit: (args: Parameters<TaskService["release"]>[0]) => Task;
  emit: (task: Task) => void;
  log: (msg: string, err?: unknown) => void;
}

/** `true` = the card is back in the queue and the caller has nothing more to do. */
export function returnEmptyNodeRunToTodo(deps: EmptyRunDeps, task: Task, nodeName: string): boolean {
  if (!task.overflowedAt) return false;
  try {
    deps.releaseAndEmit({ taskId: task.id, requeue: true, rollbackAttempt: true });
    deps.emit(deps.svc.update({ taskId: task.id, actor: "agent", by: "dispatcher", patch: { machineId: null, stayLocal: true } }));
    deps.svc.addComment({
      taskId: task.id, author: "system", kind: "service",
      content:
        `La corsa su «${nodeName}» è finita senza nessun commit: lì mancano strumenti che questa card usa. ` +
        "La rimetto in coda su questa macchina, e da ora ci resta.",
    });
    return true;
  } catch (err) {
    deps.log(`nodo: la card ${task.id} vuota non è tornata in coda`, err);
    return false;
  }
}
