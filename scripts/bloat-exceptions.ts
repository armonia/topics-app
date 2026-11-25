/**
 * The written permission a file needs to enter the bloat baseline or to grow
 * in it. The baseline only goes down: without a live exception here
 * `--update-baseline` refuses, and the total of offenders cannot rise.
 */
export interface BloatException {
  why: string;
  /** ISO day, inclusive. */
  expires: string;
}

interface Recorded {
  files: Record<string, number>;
  exceptions: Record<string, BloatException>;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function exceptionIsLive(e: BloatException | undefined): boolean {
  return !!e && typeof e.why === "string" && e.why.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(e.expires) && e.expires >= today();
}

/** Offenders that are over the line only thanks to a live exception. */
export function newlyExcepted(baseline: Recorded, over: { file: string }[]): number {
  return over.filter((f) => baseline.files[f.file] === undefined && exceptionIsLive(baseline.exceptions[f.file])).length;
}

/** Entries that are new or bigger than recorded and hold no live exception. */
export function refusedEntries(baseline: Recorded, over: { file: string; lines: number }[], baselinePath: string): string[] {
  const refused: string[] = [];
  for (const f of over) {
    const was = baseline.files[f.file];
    if ((was === undefined || f.lines > was) && !exceptionIsLive(baseline.exceptions[f.file])) {
      refused.push(
        `${f.file}: ${was === undefined ? `new offender at ${f.lines}` : `${was} -> ${f.lines}`} lines. ` +
          `Split it, or add "${f.file}": { "why": "...", "expires": "YYYY-MM-DD" } under "exceptions" in ${baselinePath}.`,
      );
    }
  }
  return refused;
}
