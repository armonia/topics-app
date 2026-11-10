/**
 * THE CIRCUIT BREAKER ON WAKING A NODE.
 *
 * `pickOverflowMachine` treats a sleeping node as a target while a `node-run`
 * hook is declared, and never looked at how the last wakes went. On 2026-11-10
 * the PC was powered on but stuck at the login screen: the hook could not bring
 * it online, yet the dispatcher sent it 8 cards at 17:14 and 8 more at 17:45,
 * each one bouncing through 7 waits into backlog.
 *
 * After `WAKE_FAIL_THRESHOLD` failed wakes in a row the node stops being
 * wakeable for a window that doubles on every further failure (15, 30, 60 min,
 * capped at 4 h). One run that starts closes the breaker. In memory on purpose:
 * a restart gives the node one fresh try, which is the cheap and honest default.
 */
export const WAKE_FAIL_THRESHOLD = 2;
export const WAKE_OPEN_BASE_MS = 15 * 60_000;
export const WAKE_OPEN_MAX_MS = 4 * 3_600_000;

interface BreakerState { fails: number; openUntil: number }

export function createWakeBreaker(clock: () => number = Date.now) {
  const state = new Map<string, BreakerState>();
  return {
    /** A wake that did not bring the node online (hook veto, node not ready). */
    failure(machineId: string): void {
      const s = state.get(machineId) ?? { fails: 0, openUntil: 0 };
      s.fails += 1;
      if (s.fails >= WAKE_FAIL_THRESHOLD) {
        const ms = Math.min(WAKE_OPEN_BASE_MS * 2 ** (s.fails - WAKE_FAIL_THRESHOLD), WAKE_OPEN_MAX_MS);
        s.openUntil = clock() + ms;
      }
      state.set(machineId, s);
    },
    /** A run started on the node: it is reachable again. */
    success(machineId: string): void { state.delete(machineId); },
    /** True while the node must not be chosen as a sleeping target. */
    isOpen(machineId: string): boolean { return (state.get(machineId)?.openUntil ?? 0) > clock(); },
    /** When the breaker closes again, for the note on the card (null = closed). */
    openUntil(machineId: string): number | null {
      const u = state.get(machineId)?.openUntil ?? 0;
      return u > clock() ? u : null;
    },
  };
}

/** The one breaker the dispatcher and the remote-node launcher share. */
export const wakeBreaker = createWakeBreaker();
