/**
 * THE SCRATCH ROOTS `testTmpDir` HANDS OUT, AND WHEN THEY GO.
 *
 * THE DEFECT (measured on 28/09/2026). The helper removed its roots in a
 * `process.on("exit")` handler, and under `bun test` (bun 1.3.8) neither `exit`
 * nor `beforeExit` ever fires. Every run left its roots behind:
 * `/tmp/topics-test` reached 76,579 directories and 36 GB, the disk hit 100%
 * and the production server logged SQLITE_FULL.
 *
 * WHY THE HELPER CANNOT CLEAN UP WITH ITS OWN `afterAll`. Measured on bun 1.3.8:
 *   - `afterAll` hooks of one scope run in DECLARATION order. One registered by
 *     `testTmpDir` at the top of a file runs BEFORE the file's own teardown
 *     declared below it, so the teardown that stops a server writing into the
 *     root finds it gone.
 *   - an `afterAll` registered while the file RUNS (inside `beforeAll`,
 *     `beforeEach` or a test) runs right after that hook or test, not at the
 *     end of the file. Registered in a root `beforeAll`, it runs before the
 *     first test.
 *   - the helper module is evaluated once per process, so code at its top
 *     level reaches the first file of a run and no other.
 *
 * WHAT HAPPENS INSTEAD. Each root is tagged with `Bun.main`, which bun points
 * at the test file it is collecting or running. Files run one after another,
 * so once `Bun.main` names a different file, every hook of the owner has
 * already run. The preload sweeps twice: before each test, the roots of files
 * that are over; after the last file of the run, all of them.
 *
 * THE ROOT THAT WAITS. `server/db.ts` keeps one database handle per PROCESS,
 * and a file that never closes it hands it to the next file, whose
 * `initDatabase` returns that same handle. Removing the root under it makes
 * the next query fail with SQLITE_IOERR_VNODE (measured). So a root whose
 * `inUse` check says yes is skipped and tried again at the next sweep; the
 * last sweep removes it anyway, because nothing runs after it.
 */
import { rmSync } from "node:fs";

interface TrackedRoot {
  /** The test file that made the root: `Bun.main` when it was created. */
  owner: string;
  /** True while something that outlives the owner file still reads the root. */
  inUse: () => boolean;
}

const tracked = new Map<string, TrackedRoot>();

/** Registers a root made by `testTmpDir` for removal once its test file is over. */
export function trackTestTmpDir(root: string, inUse: () => boolean = () => false): void {
  tracked.set(root, { owner: Bun.main, inUse });
}

/**
 * Removes the roots of the files that are over. With `runningFile`, that is
 * every root owned by another file and not in use. With `null` the run is over
 * and every root goes.
 *
 * A root that cannot be removed stays tracked for the next sweep. It never
 * throws: from a `beforeEach` that would turn a test of ANOTHER file red.
 */
export function removeFinishedTestTmpDirs(runningFile: string | null): void {
  for (const [root, { owner, inUse }] of tracked) {
    if (runningFile !== null && (owner === runningFile || inUse())) continue;
    try {
      rmSync(root, { recursive: true, force: true });
      tracked.delete(root);
    } catch (error) {
      if (runningFile === null) console.warn(`[test-tmp-dirs] could not remove ${root}: ${(error as Error).message}`);
    }
  }
}
