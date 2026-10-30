/**
 * OVERFLOW DISPATCH: a card held by THIS machine's memory floor goes to another
 * machine instead of waiting for hours.
 *
 * The floor (`dispatch-capacity.ts`) answers "can THIS Mac take one more agent",
 * and a card that runs on a paired node or on Cloud Claude does not answer to it
 * (`isRemoteTask` in the dispatcher). So while the Mac reads under its line, a
 * card that could run elsewhere is waiting for memory it does not need. On
 * 26/10/2026 eight cards moved by hand (PATCH `machineId`) went from 1 to 9 at
 * work in one minute; on 30/10 three cards sat still for the same reason with
 * the PC and the cloud online.
 *
 * WHAT MOVES: a card that would run here (no machine, or this machine's own
 * row - the board default meaning "here") and has been held by the memory floor
 * for more than `OVERFLOW_AFTER_MS`. WHAT STAYS: a card or a board explicitly
 * marked "this Mac only" (`stayLocal` / `dispatchStayLocal`) - local processes,
 * OpenClaw, sessions, macOS. A mark and not a guess on the text: a heuristic
 * that sends a macOS card to the cloud fails over there, after the wait.
 *
 * WHERE: Cloud Claude while the Claude plan has credit (no provider hold),
 * otherwise the first online paired node; the remote lane's `node-run` hook
 * wakes it before the run, the same path a person's choice takes.
 */

/** How long a card waits behind the memory floor before it moves (the floor's own window). */
export const OVERFLOW_AFTER_MS = 2 * 60_000;

/** A machine the overflow can send a card to: never this one. */
export interface OverflowMachine {
  id: string;
  /** For the line a person reads («Spostata su Cloud Claude: Mac pieno»). */
  name: string;
  /** `cloud` = the Claude cloud row, `node` = a paired computer (the PC). */
  kind: "cloud" | "node";
  /** The heartbeat's verdict: an offline machine is never chosen. */
  online: boolean;
}

/**
 * The machine a held card goes to, or `null` when there is none. Cloud first
 * while it has credit (it needs nobody and nothing to wake), then the first
 * online node in the order given (the store lists the freshest heartbeat first).
 */
export function pickOverflowMachine(
  machines: readonly OverflowMachine[],
  opts: { cloudCredit: boolean },
): OverflowMachine | null {
  const online = machines.filter((m) => m.online);
  if (opts.cloudCredit) {
    const cloud = online.find((m) => m.kind === "cloud");
    if (cloud) return cloud;
  }
  return online.find((m) => m.kind === "node") ?? null;
}

/**
 * Whether a card may leave this machine at all, before any clock: the board's
 * switch, the two "this Mac only" marks, and where the card runs today.
 */
export function overflowEligible(
  task: { machineId: string | null; stayLocal?: boolean },
  board: { dispatchOverflow?: boolean; dispatchStayLocal?: boolean },
  localMachineId: string | null,
): boolean {
  if (board.dispatchOverflow === false || board.dispatchStayLocal) return false;
  if (task.stayLocal) return false;
  return task.machineId == null || (localMachineId != null && task.machineId === localMachineId);
}

/** The one line on the card and in the thread: where it went and why. */
export function overflowNote(machineName: string): string {
  return `Spostata su ${machineName}: Mac pieno. La memoria di questa macchina è rimasta sotto il pavimento per più di 2 minuti, ` +
    `e lì il pavimento non vale. Per tenerla sul Mac segnala «solo Mac», o rimetti la macchina a mano.`;
}
