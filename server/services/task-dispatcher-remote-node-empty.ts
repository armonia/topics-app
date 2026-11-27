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
 *
 * NOT to a third node (21/11): an empty run is also the honest outcome of a
 * card with nothing to change. Skipping one node at a time, such a card bounced
 * between the two nodes for ever, because the skip remembers ONE machine and
 * the second empty run overwrote the first (f562cda4: 11 runs in 35 minutes,
 * same verdict each time). The second empty run in a row pins it HERE for the
 * same six hours: this machine has every tool the nodes may lack, and its own
 * run ends in review like any local one.
 *
 * NOT when the card's OWN prior delivery is already inside main (25/11: 47
 * empty runs a day, 178 in a week, one card reworked four times in the same
 * day always on the same already-landed commit). The node saying "nothing to
 * deliver" is read here as "missing tool" or "nothing to change" by guessing;
 * this machine can answer for real, because its own `main` is pushed to
 * origin right after every land. So before anything else this checks the
 * card's last recorded delivery against THIS machine's `main`, never against
 * the node's own worktree (a node's local main can be stale, which is a second
 * cause of the same bounce: an agent there declaring "already on main" against
 * a branch that never saw the real origin). `true` closes the card with the
 * proof in the thread; `false` or unknown falls through to the guesses below,
 * unchanged.
 *
 * NOT when a PERSON sent that delivery back asking for more (25/11, second
 * review). `main` having the old commit is exactly what a rimando looks like:
 * the delivery that got landed or reviewed is on main for that reason, and the
 * rimando is the new work nobody did yet. Closing on `landed === true` without
 * looking would drop the request on the floor the moment a node answers empty.
 * `reopenedActor === "human"` is this card's own mark of that rimando (set by
 * the same transition that leaves `review`/`done`, `tasks/status.ts`): when it
 * is set, the card goes to review instead, quoting the person's own words so
 * nobody has to go dig the thread for what was actually asked.
 */
import { HUMAN_AUTHOR, isThreadSpeech, pendingQuestionComment } from "../../shared/board";
import { reopenedByMainRed } from "./red-bounce";
import { namesMacOnlyPaths } from "./dispatch-overflow";
import type { Task, TaskService } from "./tasks";

/** The last thing a person said on the card, thread speech only: the rimando's own words. */
function lastHumanWord(comments: readonly { author: string; content: string; kind?: string | null }[]): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    if (c.author === HUMAN_AUTHOR && isThreadSpeech(c)) return c.content;
  }
  return null;
}

interface EmptyRunDeps {
  svc: TaskService;
  releaseAndEmit: (args: Parameters<TaskService["release"]>[0]) => Task;
  emit: (task: Task) => void;
  log: (msg: string, err?: unknown) => void;
  /** A machine's display name, for the line that says where the previous empty run happened. */
  nameOf?: (machineId: string) => string;
  /** Is a commit already inside THIS machine's `main`? Absent = the guard below is skipped. */
  deliveryLanded?: (repoPath: string, commit: string) => Promise<boolean | null>;
  /** This machine's own checkout for the card's project, never the node's. Absent = the guard below is skipped. */
  repoPathOfTask?: (taskId: string) => string | null;
  /** Is this machine's `main` still red? Absent = yes. */
  mainIsRed?: (repoPath: string) => Promise<boolean>;
}

/**
 * How long the pin holds. It answers to tools the node lacked, and those get
 * installed: on 10/11 five cards stayed on a Mac under its memory floor for
 * hours after gh and git reached the PC's agents. Six hours is a working
 * session: long enough not to bounce the same card back at once, short enough
 * that a fixed node gets it again the same day.
 */
export const EMPTY_RUN_PIN_MS = 6 * 60 * 60_000;

/** The post-land mark only holds while main is red: repaired elsewhere, "already in main" is the right verdict again. */
async function mainStillRed(deps: EmptyRunDeps, repoPath: string): Promise<boolean> {
  try { return deps.mainIsRed ? await deps.mainIsRed(repoPath) : true; } catch { return true; }
}

/** `true` = the card is back in the queue (or closed) and the caller has nothing more to do. */
export async function returnEmptyNodeRunToTodo(deps: EmptyRunDeps, task: Task, nodeName: string): Promise<boolean> {
  // The card's last recorded delivery, already inside OUR main: nothing to redo, whatever the node thought.
  const priorCommit = task.deliveryCommit ?? task.priorCommit ?? null;
  if (priorCommit && deps.deliveryLanded && deps.repoPathOfTask) {
    const repoPath = deps.repoPathOfTask(task.id);
    if (repoPath) {
      let landed: boolean | null = null;
      try { landed = await deps.deliveryLanded(repoPath, priorCommit); }
      catch (err) { deps.log(`nodo: sonda già-su-main fallita per ${task.id}`, err); }
      // A card sent back by the post-land red on main has its work ON main and still owes a fix on top of it.
      const mainRed = landed === true && reopenedByMainRed(deps.svc.get(task.id)?.comments ?? []) && await mainStillRed(deps, repoPath);
      if (landed === true && mainRed) {
        // Never closed as "already in main": falls through to the requeue below, the card stays in todo.
      } else if (landed === true && task.reopenedActor !== "human") {
        try {
          const closed = deps.svc.settleLanded({
            taskId: task.id,
            by: "system",
            reason: `La corsa su «${nodeName}» è finita senza nessun commit: il lavoro consegnato (${priorCommit.slice(0, 8)}) ` +
              "è già dentro main, niente da rifare.",
          });
          if (closed && closed.status === "done") {
            deps.emit(closed);
            return true;
          }
        } catch (err) { deps.log(`nodo: chiusura della card già atterrata fallita per ${task.id}`, err); }
      } else if (landed === true) {
        // A person sent this back after it landed: the node doing nothing did not do THAT. Review, not done.
        try {
          const sentBackText = lastHumanWord(deps.svc.get(task.id)?.comments ?? []) ?? "(testo non trovato nel thread)";
          deps.releaseAndEmit({ taskId: task.id, requeue: true, rollbackAttempt: true });
          // `actor: "human"` is the permission axis, not the attribution: a system bounce to review is
          // not an agent DELIVERING (the gate at `tasks/status.ts` that demands a `summary` would refuse
          // it), the same reason `askPersonAfter` in `tasks-ci-phase.ts` reads. `by: "dispatcher"` is the
          // real signature, in the thread note right below.
          deps.emit(deps.svc.update({ taskId: task.id, actor: "human", by: "dispatcher", patch: { status: "review" } }));
          deps.svc.addComment({
            taskId: task.id, author: "system", kind: "service",
            content: `La corsa su «${nodeName}» è finita senza nessun commit: il nodo non ha fatto niente, il rimando chiedeva: "${sentBackText}"`,
          });
          return true;
        } catch (err) { deps.log(`nodo: la card rimandata ${task.id} non è tornata in review`, err); }
      }
    }
  }
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
  // The skip is only ever written below, and reads back only while it holds: present = this card already came back
  // empty from another node in the last six hours, so a third node is not tried.
  const before = task.overflowSkipMachine ? deps.nameOf?.(task.overflowSkipMachine) ?? task.overflowSkipMachine : null;
  try {
    deps.releaseAndEmit({ taskId: task.id, requeue: true, rollbackAttempt: true });
    // Skip THAT node, do not pin the card here: pinned, a Mac under its memory floor held it for hours while another
    // node was online (10/11: five cards in the memory queue, PC and Nodo cloud 1 free).
    const skip = task.machineId && !before ? { machineId: task.machineId, until: new Date(Date.now() + EMPTY_RUN_PIN_MS).toISOString() } : null;
    deps.emit(deps.svc.update({ taskId: task.id, actor: "agent", by: "dispatcher", patch: skip
      ? { machineId: null, overflowSkip: skip }
      : { machineId: null, stayLocal: true, stayLocalUntil: new Date(Date.now() + EMPTY_RUN_PIN_MS).toISOString() } }));
    deps.svc.addComment({
      taskId: task.id, author: "system", kind: "service",
      content: before
        ? `Anche la corsa su «${nodeName}» è finita senza nessun commit, dopo quella su «${before}»: la rimetto in coda qui, ` +
          "«solo Mac» per 6 ore. Qui ci sono gli strumenti che ai nodi possono mancare, e la corsa finisce in review come ogni altra."
        : `La corsa su «${nodeName}» è finita senza nessun commit: forse lì manca uno strumento che questa card usa. ` +
          "La rimetto in coda: per 6 ore non torna lì, ma può andare su un'altra macchina appena una ha un posto libero.",
    });
    return true;
  } catch (err) {
    deps.log(`nodo: la card ${task.id} vuota non è tornata in coda`, err);
    return false;
  }
}
