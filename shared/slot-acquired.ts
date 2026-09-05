/**
 * THE LINE THAT SAYS "THE CLOCK STARTS NOW".
 *
 * `scripts/slot.ts` queues for one of the machine's gate slots before it runs
 * the wrapped command, and prints this line to stderr the moment it holds one,
 * with the time spent in the queue. Whoever times the command from OUTSIDE
 * under a cap of its own - the board's pre-review checks, 20 minutes - reads
 * the line and restarts that cap: queueing is not the command's time.
 *
 * Until 05/09/2026 the board counted it as such. Under a fleet the queue alone
 * ran past ten minutes (three slots, four agents, each check behind the
 * others), so `test:unit` was killed by the board while still WAITING to
 * start, and the card read "timeout" for a suite that had not run one test.
 *
 * Lives in shared/ because both sides read it: the script that prints it and
 * the server that parses it.
 */
export const SLOT_ACQUIRED_PREFIX = "[slot] acquired";

export function slotAcquiredLine(label: string, queuedMs: number): string {
  return `${SLOT_ACQUIRED_PREFIX} ${label}: ${Math.max(0, Math.round(queuedMs / 1000))} s in the queue, the command starts now`;
}

const ACQUIRED_RE = /\[slot\] acquired [^\n]*?: (\d+) s in the queue/;

/** The queue time the line carries, in ms, or null when `text` has no such line. */
export function parseSlotAcquired(text: string): number | null {
  const m = ACQUIRED_RE.exec(text);
  return m ? Number(m[1]) * 1000 : null;
}
