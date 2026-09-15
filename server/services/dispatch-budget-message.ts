/**
 * The sentences a card in the queue carries when the budget gate holds it, and
 * which memory clause fired. Split out of task-dispatcher.ts, which is past its
 * size ceiling: these are pure functions of the verdict, with no dispatcher
 * state, so they live beside it rather than inside it.
 */
import type { AdmissionVerdict } from "../../shared/board";

/** `1.4` as `1,4`: the sentence is Italian like the rest of this file's card
 *  lines, and a decimal point in an Italian sentence reads as a typo. */
const itNumber = (n: number, digits = 1): string => n.toFixed(digits).replace(".", ",");
const asPercent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

/**
 * "OVER THE BUDGET", written on the card WITH the numbers that produced it: how
 * much of this computer Topics is taking, the budget it was given, and the
 * usable share when the rest of the machine has squeezed it. Without them the
 * line is "in coda" again, which is the sentence the chip already says and the
 * one that made a paused board look like a broken one.
 *
 * It says the wait ends by itself. That is the difference from the floor's line
 * (which does not promise it) and from the spend cap's (which says what to do
 * instead): three brakes, three sentences, and each one true about its own way
 * of ending.
 *
 * Exported for the test, which asserts on the numbers and not on the prose.
 */
export function machineBudgetMessage(
  verdict: AdmissionVerdict,
  cores: number,
  share: number,
  /** Our footprint and its ceiling, as the gate compared them. Absent = only
   *  the quota clause can be told. */
  mem?: { ourMemGB: number; usableMemGB: number },
): string {
  if (verdict.blockedBy === "memory") {
    // TWO CLAUSES, TWO SENTENCES. The axis also holds when our footprint is
    // over its ceiling while the next agent would fit in the free quota (two
    // 11 GB shard runs on a 34 GB Mac). Printing the quota there wrote "needs
    // 1,5 GB, 4,2 GB free for Topics", which by its own numbers admits, and
    // hid the real cause: what Topics is already holding.
    if (mem && memoryClause(verdict, mem) === "footprint") {
      return (
        `Non c'è memoria per un altro agent: Topics tiene ${itNumber(mem.ourMemGB)} GB, ` +
        `oltre il ${asPercent(share)} della RAM (${itNumber(mem.usableMemGB)} GB). ` +
        `Non ne parte un altro finché non scende: riparte da sé, niente è andato perso.`
      );
    }
    // The memory sentence says the two numbers the axis actually compared: what
    // one more agent costs, and the share of the FREE memory it did not fit in.
    // "Topics is at its memory ceiling" was true of a footprint nobody could
    // see and said nothing about the machine being in swap.
    const quota = verdict.freeQuotaMemGB;
    const room = quota == null ? "" : ` (ne servono ${itNumber(verdict.costMemGB)} GB, liberi per Topics ${itNumber(quota)} GB)`;
    return (
      `Non c'è memoria per un altro agent: il ${asPercent(share)} di quella libera non basta${room}. ` +
      `Non ne parte un altro finché non si libera: riparte da sé, niente è andato perso.`
    );
  }
  // Said in the panel's words: the cores Topics holds against the cores at its
  // disposal, which is the share of what the rest of the machine leaves free.
  // When that is less than the slider promises, the line says why, or a number
  // smaller than the setting reads as the setting not being honoured.
  const squeezed = verdict.usableCoreUnits < verdict.budgetCoreUnits - 0.05 ? ", e il resto della macchina sta lavorando" : "";
  return (
    `Topics usa ${itNumber(verdict.usedCoreUnits)} dei ${itNumber(verdict.usableCoreUnits)} core a disposizione ` +
    `(quota ${asPercent(share)} del libero${squeezed}); un agent nuovo ne costa ${itNumber(verdict.costCoreUnits)}. ` +
    `Non ne parte un altro finché non scende: riparte da sé, niente è andato perso.`
  );
}

/**
 * Which memory clause a `memory` verdict fired on. The quota comes first: when
 * the next agent does not fit in the free share, that is the sentence that
 * explains itself, whatever the footprint. `null` when memory did not hold.
 */
export function memoryClause(
  verdict: Pick<AdmissionVerdict, "blockedBy" | "costMemGB" | "freeQuotaMemGB">,
  mem: { ourMemGB: number; usableMemGB: number },
): "quota" | "footprint" | null {
  if (verdict.blockedBy !== "memory") return null;
  if (verdict.freeQuotaMemGB != null && verdict.costMemGB > verdict.freeQuotaMemGB) return "quota";
  return mem.ourMemGB > mem.usableMemGB ? "footprint" : "quota";
}
