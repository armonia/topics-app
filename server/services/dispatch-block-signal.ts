/**
 * THE MACHINE-WIDE BLOCK, said out loud where the card can read it.
 *
 * The tick reads two blocks once per round and then skips EVERY card: the
 * resource floor (`dispatchResourceBlock`: disk or RAM under the floor) and the
 * 24h spend cap (`SpendBrake.dayBlock`). Both are properties of the machine,
 * not of a row, so nothing in the `tasks` table records them and the card
 * mapper had no way to know. It fell through to the queue branch and wrote "in
 * coda, la prossima" on a board that had not moved in hours.
 *
 * Why a process singleton and not a column: the fact IS about this process's
 * machine, it changes every ten seconds, and it is the same answer for every
 * board. A column would be a write per tick to say what a variable says for
 * free, and after a crash it would keep claiming a disk that is no longer full.
 * The dispatcher sets it every tick (including back to `null` when the block
 * lifts), so it never outlives the thing it describes.
 *
 * With no dispatcher running - a test that builds the tasks service on its own,
 * a headless import - it stays `null` and the mapper behaves exactly as before.
 */

/** Which of the two machine-wide blocks fired. */
export type DispatchBlockKind = "resources" | "spend";

export interface DispatchBlock {
  kind: DispatchBlockKind;
  /**
   * The sentence the block composed for itself, numbers included ("2.1 GB
   * available, under the floor of 3 GB"). It travels because the numbers are
   * the answer, and nobody downstream can measure this machine again.
   */
  reason: string;
}

let current: DispatchBlock | null = null;

/** The tick's verdict for this round. `null` clears it: the block has lifted. */
export function setDispatchBlock(block: DispatchBlock | null): void {
  current = block;
}

/** What is holding the whole queue right now, or `null` if nothing is. */
export function currentDispatchBlock(): DispatchBlock | null {
  return current;
}
