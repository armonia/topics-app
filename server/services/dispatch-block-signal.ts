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

/**
 * Which of the three machine-wide blocks fired.
 *
 * `resources` is the hard floor (disk or RAM under a fixed line), `pressure`
 * is the opt-in "by resources" cap (load or memory over the threshold the
 * person chose), `spend` is the 24h bill, `plan` is the subscription's
 * five-hour window nearly gone. Different kinds for brakes that look alike on
 * purpose: the card mapper gives them different tones, because one is a wait
 * that dissolves by itself and the other is not.
 */
export type DispatchBlockKind = "resources" | "pressure" | "spend" | "plan";

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

/**
 * The tick's verdict, published and turned into the line for the thread.
 *
 * Both arguments come straight out of the two brakes the tick already reads
 * once per round (`admissionBlock()` and `SpendBrake.dayBlock()`); this is the
 * one place that decides which of them wins and what it READS like, so the chip
 * and the thread line cannot drift apart.
 *
 * The spend one is re-composed: `dayBlock` returns the FRAGMENT its log line
 * embeds ("spesa: $12 negli ultimi 24h su un tetto di $10"), and a fragment   allow-italian: the quoted fragment the brake returns
 * dropped alone on a card reads like a truncated string. The floor's message is
 * already a sentence, with its numbers, and it travels as it is.
 *
 * THE ORDER, when more than one holds: floor, then spend, then pressure. The
 * floor wins over pressure because a full disk does not reabsorb itself while
 * load does: showing "load over the threshold, it restarts by itself" on a
 * machine whose SQLite writes are about to fail would promise a restart that
 * never comes. Spend wins over pressure for the same reason on the other axis:
 * the bill does not go down by waiting, and the sentence that says what to do
 * (raise the cap) must not be hidden behind a wait that will pass anyway.
 *
 * Returns the sentence to write in the thread, or `null` when nothing is
 * holding the queue.
 */
export function publishDispatchBlock(
  resourceFloor: string | null,
  daySpendBlock: string | null,
  /** The "by resources" verdict, already a full sentence with its numbers
   *  (see `machinePressureMessage` in the dispatcher). Absent or `null` when
   *  the mode is off or the machine is under its thresholds. */
  pressureBlock: string | null = null,
  /** The plan's five-hour window over the dispatch threshold, already a full
   *  sentence with the percentage and the reset hour (see `tick`). Null when
   *  there is no reading, or the window is under the threshold. */
  planBlock: string | null = null,
): string | null {
  const spend = daySpendBlock
    ? `Tetto di spesa giornaliero raggiunto (${daySpendBlock.replace(/^spesa:\s*/, "")}). `
      + "Non parte niente su nessuna board finché la finestra delle 24 ore non scorre, "   // allow-italian: the sentence shown on the card
      + "oppure finché non alzi il tetto dalle impostazioni della board."                  // allow-italian: the sentence shown on the card
    : null;
  setDispatchBlock(
    resourceFloor ? { kind: "resources", reason: resourceFloor }
      : spend ? { kind: "spend", reason: spend }
        : planBlock ? { kind: "plan", reason: planBlock }
          : pressureBlock ? { kind: "pressure", reason: pressureBlock }
            : null,
  );
  return resourceFloor ?? spend ?? planBlock ?? pressureBlock;
}
