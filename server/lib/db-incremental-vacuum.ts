/**
 * GIVING FREE PAGES BACK TO THE DISK, WHILE NOBODY IS WORKING.
 *
 * With `auto_vacuum = INCREMENTAL` (new databases are born that way, older ones
 * are converted once by `scripts/enable-incremental-vacuum.ts`), pages freed by
 * a DELETE stay on the freelist until `PRAGMA incremental_vacuum(N)` moves
 * pages from the end of the file into those holes and truncates the file.
 *
 * WHY IN STEPS, AND ONLY AT REST. `bun:sqlite` is synchronous: a step blocks
 * the event loop for as long as it runs, and holds the write lock. Measured on
 * a synthetic database (3 KB rows, WAL): 512 pages take 3-5 ms, 1,024 up to
 * 20 ms. So a step is 512 pages, the loop yields between steps, and a round
 * stops at 16,384 pages (64 MB at 4 KB pages): a large DELETE is given back
 * over several rounds instead of in one long stall. Before EVERY step the round
 * asks the restart gate's own predicate (`whatIsStillWorking` in server.ts):
 * if it would hold a restart, it holds this too, and a turn that starts in the
 * middle of a round stops it at the next step.
 */
import type { Database } from "bun:sqlite";

/** How often a round runs. Free pages are not urgent: they are only disk. */
export const INCREMENTAL_VACUUM_EVERY_MS = 10 * 60_000;
/** Pages released per `incremental_vacuum` call. */
export const INCREMENTAL_VACUUM_STEP_PAGES = 512;
/** Pages released per round, at most. */
export const INCREMENTAL_VACUUM_MAX_PAGES = 16_384;

/** `PRAGMA auto_vacuum` value for INCREMENTAL. */
const AUTO_VACUUM_INCREMENTAL = 2;

export interface IncrementalVacuumDeps {
  db: Database;
  /** What is still working, or null at rest: the restart gate's predicate. */
  busy: () => string | null | Promise<string | null>;
  log?: (line: string) => void;
  stepPages?: number;
  maxPages?: number;
}

export type IncrementalVacuumOutcome =
  | { action: "skipped"; reason: string }
  | { action: "vacuumed"; pages: number; remaining: number; stoppedBy: string | null };

function readSetting(db: Database, name: string): number {
  return Object.values(db.query(`PRAGMA ${name}`).get() as Record<string, number>)[0];
}

/** One round. Returns what it did, so the test checks the decision. */
export async function runIncrementalVacuum(deps: IncrementalVacuumDeps): Promise<IncrementalVacuumOutcome> {
  const { db } = deps;
  const stepPages = deps.stepPages ?? INCREMENTAL_VACUUM_STEP_PAGES;
  const maxPages = deps.maxPages ?? INCREMENTAL_VACUUM_MAX_PAGES;

  const mode = readSetting(db, "auto_vacuum");
  if (mode !== AUTO_VACUUM_INCREMENTAL) return { action: "skipped", reason: `auto_vacuum is ${mode}, not INCREMENTAL` };
  let free = readSetting(db, "freelist_count");
  if (free === 0) return { action: "skipped", reason: "no free pages" };

  let released = 0;
  let stoppedBy: string | null = null;
  while (free > 0 && released < maxPages) {
    const holder = await deps.busy();
    if (holder) {
      stoppedBy = holder;
      break;
    }
    db.run(`PRAGMA incremental_vacuum(${Math.min(stepPages, maxPages - released)})`);
    const after = readSetting(db, "freelist_count");
    // A step that released nothing would loop forever.
    if (after >= free) break;
    released += free - after;
    free = after;
    // Let the requests queued behind this step run before the next one.
    await new Promise((r) => setTimeout(r, 0));
  }

  if (released === 0 && stoppedBy) return { action: "skipped", reason: stoppedBy };
  if (released > 0) {
    deps.log?.(`[incremental-vacuum] released ${released} pages, ${free} still free${stoppedBy ? ` (stopped: ${stoppedBy})` : ""}`);
  }
  return { action: "vacuumed", pages: released, remaining: free, stoppedBy };
}
