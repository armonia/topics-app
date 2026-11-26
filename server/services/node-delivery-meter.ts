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
 * A LOCAL COMMAND (typecheck, unit tests) runs here too, not just the CI
 * rows: the checkout installs its dependencies before any gate runs
 * (`node-check-worktree.ts`), so a red on it means "the code is wrong", not
 * "nothing is installed" — the hole a local-only board used to fall through
 * forever (card c0bec773, 26/11: a board with even one local row never got
 * measured, so a node delivery on it never landed). The swap brake
 * (`checks-gate.ts`'s `InterruptReason`) already covers every row the same
 * way, CI or local, so nothing extra is needed for it.
 */
import type { ReviewCheck } from "../../shared/board";
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
  log?: (line: string) => void;
  legMs?: number;
  /** Legs before giving up on a round that never settles. */
  maxLegs?: number;
}

export function createNodeDeliveryMeter(deps: NodeDeliveryMeterDeps) {
  const log = deps.log ?? (() => undefined);
  const legMs = deps.legMs ?? 60_000;
  const maxLegs = deps.maxLegs ?? 80;
  const measuring = new Set<string>();

  async function measure(taskId: string): Promise<void> {
    if (measuring.has(taskId)) return;
    const task = deps.readTask(taskId);
    if (!task || task.status !== "review" || !task.deliveryBranch || !task.deliveryCommit) return;
    const checks = deps.declaredChecks(task.projectId);
    if (!checks.length) return;
    if (!deps.checkout) return;
    measuring.add(taskId);
    try {
      const lease = await deps.checkout(taskId);
      if (!lease) { log(`[node-meter] ${taskId.slice(0, 8)}: nessun checkout su cui misurare`); return; }
      try {
        const at = async () => ({ cwd: lease.cwd, commit: await lease.head() });
        for (let leg = 0; leg < maxLegs; leg++) {
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
      log(`[node-meter] ${taskId.slice(0, 8)}: misura fallita: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      measuring.delete(taskId);
    }
  }

  return { measure, isMeasuring: (taskId: string) => measuring.has(taskId) };
}
