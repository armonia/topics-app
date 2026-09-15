/**
 * THE TWO BRAKES OF A PRE-REVIEW ROUND THAT DO NOT LIVE IN THE COMMAND.
 *
 * `slot.ts` holds a command back while another run of the same gate is alive;
 * the governor pauses a run already going. Neither of them could stop a NEW
 * command from starting on a machine out of memory, and nothing stopped a
 * running tree when the server itself went away. Both are here, and
 * `runReviewChecks` (review-checks.ts) consults them around every command.
 */
import { freezableRuns } from "./budget-governor";
import { ChecksInterruptedError } from "./checks-gate";
import { killProcessTree } from "../lib/process-tree";

/**
 * NO NEW CHECK STARTS UNDER THE MEMORY FLOOR.
 *
 * Every brake in front of a check counted something other than free memory:
 * the lanes of the gate (2 on 12 cores), the slots and names of `slot.ts`, the
 * load of the unit runner. The admission cannot price it either: a card is
 * admitted while memory is free and delivers tens of minutes later, and its
 * `test:unit` tree (4-11 GB) is a child of the server, not of the session the
 * admission measured. Measured 15/09/2026: `availableMemGB` 5.9 with 9.9 GB of
 * swap, and nothing in the code could have held the next bar.
 *
 * So each declared command waits, before it is spawned, while the reading is
 * under the floor. The command's deadline is not running during the wait: it is
 * armed at spawn, exactly like the slot queue does not count against it.
 *
 * IT FAILS OPEN, like every other brake on a gate: the round waits at most
 * `maxWaitMs` IN TOTAL, then the remaining commands start whatever the memory
 * says. A reading that cannot be taken (`null`, a throw) never waits.
 */
export interface MemoryFloor {
  /** Free memory now, in GB; `null` = not measured. */
  read: () => number | null;
  /** Under this, a new command waits. */
  floorGB: number;
  /** Total wait of one round before running anyway. Default `MEMORY_WAIT_MAX_MS`. */
  maxWaitMs?: number;
  /** How often the memory is read again while waiting. */
  pollMs?: number;
}

/** Thirty minutes, the same limit as a gate waiting for another run of itself
 *  (`defaultNameMaxWaitMs`). Added up, the waits of one round can outlast the 50
 *  minutes `update_task` polls; the verdict still lands, re-issued by the route
 *  (`pendingDeliveries`) once the client has given up. */
const MEMORY_WAIT_MAX_MS = 30 * 60_000;
const MEMORY_POLL_MS = 5_000;

/** One waiter per round: its budget of `maxWaitMs` is spent across the round. */
export function memoryWaiter(floor: MemoryFloor | undefined, signal?: AbortSignal): (name: string) => Promise<void> {
  if (!floor) return async () => {};
  const maxWaitMs = floor.maxWaitMs ?? MEMORY_WAIT_MAX_MS;
  const pollMs = Math.max(1, floor.pollMs ?? MEMORY_POLL_MS);
  let spentMs = 0;
  /** The reading when it is under the floor, `null` otherwise. */
  const tight = (): number | null => {
    try {
      const gb = floor.read();
      return gb != null && Number.isFinite(gb) && gb < floor.floorGB ? gb : null;
    } catch { return null; }
  };
  return async (name) => {
    if (spentMs >= maxWaitMs) return;
    let gb = tight();
    if (gb === null) return;
    console.warn(`[review-checks] ${gb.toFixed(1)} GB of free memory, under the ${floor.floorGB} GB floor: "${name}" waits before starting`);
    const from = Date.now();
    while (gb !== null && !signal?.aborted && !stopping) {
      const left = maxWaitMs - spentMs - (Date.now() - from);
      if (left <= 0) break;
      await Bun.sleep(Math.min(pollMs, left));
      gb = tight();
    }
    spentMs += Date.now() - from;
    if (gb !== null && !signal?.aborted && !stopping) {
      console.warn(`[review-checks] memory still under the floor after ${Math.round(spentMs / 60_000)} min: "${name}" starts anyway`);
    }
  };
}

/**
 * A SERVER THAT STOPS TAKES ITS CHECK TREES WITH IT, and records no verdict.
 *
 * `slot.ts` spawns the command in a process group of its own, and nothing
 * killed it when the server exited: after a reload the whole tree was
 * reparented to pid 1 and ran to the end, holding its memory, with nobody left
 * to read the verdict. Seen live on 15/09/2026 at 02:04: four
 * `test:unit:shards` trees at once, two of them orphans of the server that had
 * restarted at 01:51, beside the two the new server had started for the same
 * cards.
 *
 * A run killed here is not a red: the code was never measured. So after the
 * kill the round throws `ChecksInterruptedError` instead of returning the
 * killed run, and the gate turns it into an INTERRUPTED outcome (checks-gate.ts):
 * nothing is recorded, the delivery waiting on the round answers 503 "call
 * again" without moving the card, and the card is measured again after the
 * restart. The same flag stops any command that has not started yet.
 */
let stopping = false;

export function throwIfStopping(): void {
  if (stopping) throw new ChecksInterruptedError();
}

/** The server is on its way out: a delivery that would start a new round (and
 *  realign its branch first) is told to call again instead. */
export function reviewChecksStopping(): boolean {
  return stopping;
}

/** Kills every running check tree and stops the rounds from starting another
 *  command. Resolves once the SIGTERMs are sent; returns how many trees. */
export async function stopReviewChecks(kill: (pid: number) => Promise<void> = killProcessTree): Promise<number> {
  stopping = true;
  const live = freezableRuns();
  await Promise.all(live.map((run) => kill(run.pid).catch(() => { /* already gone */ })));
  return live.length;
}

/** Test seam: a stop is for the life of the process, a test file is not. */
export function _resetReviewChecksStop(): void {
  stopping = false;
}
