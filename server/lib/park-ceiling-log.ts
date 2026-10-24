/**
 * Prints the memory-ceiling state of the idle-park sweep: once on entry, once on
 * each change of the tightened threshold, and once on the way out.
 *
 * The sweep used to print on every 60 s tick while the machine stayed at the
 * ceiling. Entries and exits are the facts; the ticks in between carry none.
 * Kept apart from `terminal.ts` so the rule can be tested without the timer.
 *
 * `threshold` is null when the pressure reading is unknown (no probe, or a probe
 * that threw). That says nothing about the ceiling, so the state stays as it is:
 * reading it as "back to normal" printed an exit and then a second entry for a
 * machine that never left the ceiling.
 */
export function createCeilingReporter(
  log: (line: string) => void = (line) => console.log(line),
): (parkMs: number, threshold: number | null) => void {
  let tightenedTo: number | null = null;
  return function reportCeiling(parkMs, threshold) {
    if (threshold === null) return;
    const toMin = (ms: number) => Math.round(ms / 60_000);
    if (threshold === parkMs) {
      if (tightenedTo !== null) {
        log(`[Terminal] Macchina rientrata dal soffitto: soglia di parcheggio ${toMin(parkMs)} min.`);
        tightenedTo = null;
      }
      return;
    }
    if (threshold === tightenedTo) return;
    log(`[Terminal] Macchina al soffitto: soglia di parcheggio ${toMin(parkMs)} -> ${toMin(threshold)} min per questa passata.`);
    tightenedTo = threshold;
  };
}
