/**
 * A DELIVERY PLANTED FROM ANOTHER MACHINE GETS ITS BAR TOO.
 *
 * The node lane (`task-dispatcher-remote-node.ts`) plants the branch of a run
 * that finished on the PC and moves the card to review. It never ran the
 * board's bar: the checks gate wants a worktree, and a planted branch has none
 * (measured 08/11: 46 PC deliveries on this board since 20/10, 0 green, 45 with
 * no bar at all, against 19 green of 21 local ones). So every one of them waited
 * for a person, whatever it touched.
 *
 * Here the bar is measured on a throwaway checkout of the planted branch and
 * the card is then offered to the automatic land (`auto-land.ts`).
 *
 * Only a bar made of CI rows is measured this way. A local command (typecheck,
 * unit tests) needs the installed dependencies of a real worktree, and running
 * it on a bare checkout would write a red that means "nothing is installed",
 * not "the code is wrong". Such a card stays unmeasured and a person decides,
 * which is what happens today.
 */
import { existsSync } from "node:fs";
import { isCiEvidenceCheck, type ReviewCheck } from "../../shared/board";
import type { ChecksLeg } from "./checks-gate";

/** A throwaway worktree on the planted branch. */
export interface NodeDeliveryCheckout {
  cwd: string;
  /** The commit the checkout is on RIGHT NOW (the realign moves it). */
  head(): Promise<string | null>;
  release(): Promise<void>;
}

interface NodeDeliveryMeterDeps {
  readTask(taskId: string): { status: string; projectId: string; deliveryBranch: string | null; deliveryCommit: string | null } | undefined;
  declaredChecks(projectId: string): readonly ReviewCheck[];
  checkout?: (taskId: string) => Promise<NodeDeliveryCheckout | null>;
  /** The router's own gate, pointed at the throwaway checkout. */
  runGate(
    taskId: string,
    projectId: string,
    legMs: number,
    checkout: () => Promise<{ cwd: string; commit: string | null } | null>,
  ): Promise<ChecksLeg>;
  /** Snapshot the delivery again: the realign moved the tip and the labels follow it. */
  recapture(taskId: string): Promise<unknown>;
  tryLand(projectId: string, taskId: string): Promise<unknown>;
  /** A service comment on the card: the reason a card in review with no verdict does not have one running either. */
  note?: (taskId: string, text: string) => void;
  log?: (line: string) => void;
  legMs?: number;
  /** Legs before giving up on a round that never settles. */
  maxLegs?: number;
  /** Seam for the test: whether a path is on disk right now. */
  existsSync?: (path: string) => boolean;
}

export function createNodeDeliveryMeter(deps: NodeDeliveryMeterDeps) {
  const log = deps.log ?? (() => undefined);
  const note = deps.note ?? (() => undefined);
  const legMs = deps.legMs ?? 60_000;
  const maxLegs = deps.maxLegs ?? 80;
  const exists = deps.existsSync ?? existsSync;
  const measuring = new Set<string>();
  // One throwaway checkout at a time, whichever card it is for: the review
  // sweep above may now run several remeasures at once, but a node delivery
  // never had a worktree of its own to run that many checkouts in parallel.
  let queueTail: Promise<void> = Promise.resolve();

  /** Every exit that leaves the card with checks_state NULL and no round running says why, on the log AND the card. */
  function giveUp(taskId: string, reason: string): void {
    const line = `[node-meter] ${taskId.slice(0, 8)}: ${reason}`;
    log(line);
    note(taskId, reason);
  }

  async function measure(taskId: string): Promise<void> {
    if (measuring.has(taskId)) return;
    const task = deps.readTask(taskId);
    if (!task || task.status !== "review" || !task.deliveryBranch || !task.deliveryCommit) return;
    const checks = deps.declaredChecks(task.projectId);
    if (!checks.length || !checks.every(isCiEvidenceCheck)) {
      giveUp(taskId, "la barra della board ha comandi locali, resta non misurata: serve una persona");
      return;
    }
    const checkout = deps.checkout;
    if (!checkout) { giveUp(taskId, "nessun checkout disponibile su questo server per misurare una consegna di nodo"); return; }
    measuring.add(taskId);
    const run = async (): Promise<void> => {
      try {
        let lease = await checkout(taskId);
        if (!lease) { giveUp(taskId, "nessun checkout su cui misurare"); return; }
        try {
          const at = async () => ({ cwd: lease!.cwd, commit: await lease!.head() });
          for (let leg = 0; leg < maxLegs; leg++) {
            // The cwd can be gone under the measure (a process before tore the
            // checkout down before releasing its own lease): launching a command
            // on a folder that is not there measures nothing, it only writes a
            // `spawnError`. Redo the checkout on the same delivered commit
            // instead, with no command ever launched on the void.
            if (!exists(lease.cwd)) {
              log(`[node-meter] ${taskId.slice(0, 8)}: checkout sparito, lo rifaccio`);
              const fresh = await checkout(taskId).catch(() => null);
              if (!fresh) { giveUp(taskId, "non misurato: checkout sparito"); return; }
              lease = fresh;
              continue;
            }
            const out = await deps.runGate(taskId, task.projectId, legMs, at);
            if (out && "pending" in out) continue;
            break;
          }
        } finally {
          await lease.release().catch(() => undefined);
        }
        await deps.recapture(taskId);
        await deps.tryLand(task.projectId, taskId);
      } catch (err) {
        giveUp(taskId, `misura fallita: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        measuring.delete(taskId);
      }
    };
    const prevTail = queueTail;
    queueTail = prevTail.then(run, run);
    return queueTail;
  }

  return { measure, isMeasuring: (taskId: string) => measuring.has(taskId) };
}
