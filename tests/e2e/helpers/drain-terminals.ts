/**
 * KEEP ASKING UNTIL THEY ARE GONE, OR UNTIL THE BUDGET IS SPENT.
 *
 * A terminal session is a row in SQLite AND a PTY in the bridge. Deleting the
 * row does not kill the process, and the server's reconcile writes a live
 * process back into the list — so a file that starts right after a DELETE can
 * find the session it just removed. Killing takes a round trip to the bridge:
 * on a quiet machine that is instant, on a loaded CI runner it is not.
 *
 * The guard in `hermetic.ts` used to fire ONE extra round of DELETEs and check
 * in the same millisecond, which asks a process to have died in no time at all.
 * Measured on 2026-09-12, CI run 34669019794 shard 4: two sessions survived,
 * the next file refused to start, and every file after it in that shard died at
 * 0 ms — 100+ reds out of one slow teardown. The same pair run back to back on
 * a developer machine straight after: 15 green. A race, not a stuck process.
 *
 * Separated from the fixture so the loop can be TESTED: a probe that clears on
 * the third round and one that never clears are two lines here, and neither is
 * reachable by running the suite and hoping.
 */

/** How often to re-ask while the budget lasts. */
const ROUND_MS = 150;

/**
 * Delete, look, repeat until the list is empty or `budgetMs` is spent.
 *
 * Returns what is STILL there — empty when the teardown made it, and the ids to
 * name in the error when it did not. It never throws: deciding what a survivor
 * means belongs to the caller.
 */
export async function drainTerminalSessions(
  list: () => Promise<string[]>,
  kill: () => Promise<unknown>,
  budgetMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = Date.now,
): Promise<string[]> {
  const deadline = now() + Math.max(0, budgetMs);
  // At least one round, always: a zero budget still gets the second DELETE the
  // guard has always fired, it just does not wait around after it.
  for (;;) {
    await kill();
    const left = await list();
    if (left.length === 0) return [];
    if (now() >= deadline) return left;
    await sleep(ROUND_MS);
  }
}
