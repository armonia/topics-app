/**
 * The cap on project watchers is a MEMORY guard, not a denial.
 *
 * `watchProjectFiles` refused the twenty-fifth project in silence: no
 * `files:changed`, no git status push, no log, for the whole life of the
 * server — while the twenty-four slots could be held by folders already
 * deleted. Measured in CI (2026-09-06): an e2e shard opens some thirty
 * temporary projects one after the other, and the spec "the first change
 * brings the git section back" waited 25 s for a push that never left.
 *
 * Real watchers on real folders, because the promise is that a write to the
 * newest project reaches the broadcast even when older projects filled the cap.
 * The debounce is 300 ms; the waits are on a condition, never on the clock.
 *
 * @covers PROJECT-12 — "the condition is LIVE": the section comes back on the
 * first change, which needs the watcher of that project to exist at all.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MAX_WATCHERS, unwatchProjectFiles, watchProjectFiles, watchedProjectPaths } from "./file-watcher";
import type { AppContext } from "./types";
import { slackMs } from "../tests/helpers/time-slack";

type Frame = { type: string; projectPath?: string };

/**
 * THE BUDGET IS A GUARD AGAINST A WATCHER THAT NEVER FIRES, not a measure of
 * how fast one fires. Six seconds were enough on an idle machine and not on a
 * loaded one: the pre-review checks run at nice 15 by design (KANBAN-78), and
 * on 2026-09-06 at 17:40, with load 20 on twelve cores, twenty-five recursive
 * watchers took longer than that to hand over one event - both cases red on a
 * card that had not touched the watcher. A condition wait costs nothing when
 * the event is quick, so the ceiling is set where only a real hang reaches it,
 * under the 40 s the shard runner gives a test.
 */
/**
 * How long a test of this file may take. Twenty-five OS watchers are armed on a
 * fresh temp tree and then a write has to travel through the kernel: that is
 * I/O, and on a machine running the whole sharded suite at once it can take
 * longer than the suite's 30s default. Seen red exactly there on 2026-09-07,
 * green alone on the same commit, which is the signature of a budget that
 * measures the load instead of the code. The budget is never spent when the
 * watcher works: `until` returns on the first matching frame.
 *
 * Raising it by hand is what already failed here (six seconds, then thirty, red
 * again anyway), so the number is written for a QUIET machine and widened by
 * the load through `slackMs` - one factor for the whole run, shared with the
 * other tests that wait on a window (tests/helpers/time-slack.ts).
 */
const WATCHER_TEST_MS = slackMs(60_000);
/** Between two pokes: comfortably over the watcher's 300 ms debounce. */
const POKE_MS = 1_500;

/**
 * WAIT BY POKING, not by hoping. A recursive `fs.watch` is not armed the moment
 * the call returns: on macOS the FSEvents stream is set up asynchronously, so a
 * write that lands in that window produces NO event, ever - and then no budget
 * is long enough, because nothing is on its way. That is the shape of the red
 * seen on 2026-09-06 and again on 2026-09-07 under the sharded suite, always
 * green alone: not a slow event, a lost one.
 *
 * So the write is repeated while we wait. The watcher debounces (300 ms), so
 * the extra writes cost nothing once one has been seen, and the loop leaves on
 * the first matching frame.
 */
async function until(cond: () => boolean, poke?: () => void, budgetMs = WATCHER_TEST_MS / 2): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let nextPoke = 0;
  while (Date.now() < deadline) {
    if (cond()) return true;
    // Never faster than POKE_MS: a write inside the debounce window RESTARTS
    // it, so a tight loop of writes is a broadcast that never leaves. Measured
    // here: poking every 100 ms held both cases silent for the whole budget.
    if (Date.now() >= nextPoke) { poke?.(); nextPoke = Date.now() + POKE_MS; }
    await Bun.sleep(50);
  }
  return cond();
}

describe("file watcher cap", () => {
  const roots: string[] = [];
  const watched: string[] = [];

  afterEach(() => {
    for (const p of watched) unwatchProjectFiles(p);
    watched.length = 0;
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  function project(root: string, name: string): string {
    const p = join(root, name);
    mkdirSync(p, { recursive: true });
    return p;
  }

  function armed(ctx: AppContext, p: string) {
    watched.push(p);
    watchProjectFiles(p, ctx);
  }

  test("the project after the cap still gets its files:changed", async () => {
    const root = mkdtempSync(join(tmpdir(), "fswatch-cap-"));
    roots.push(root);
    const sent: Frame[] = [];
    const ctx = { broadcastToAll: (m: unknown) => void sent.push(m as Frame) } as unknown as AppContext;

    for (let i = 0; i < MAX_WATCHERS; i++) armed(ctx, project(root, `p${i}`));
    const last = project(root, "last");
    armed(ctx, last);

    const arrived = await until(
      () => sent.some(f => f.type === "files:changed" && f.projectPath === last),
      () => writeFileSync(join(last, "a.txt"), `${Date.now()}\n`),
    );
    expect(arrived, "the twenty-fifth project must broadcast like the first").toBe(true);
  }, WATCHER_TEST_MS);

  test("a deleted folder gives its slot back before a live one is evicted", async () => {
    const root = mkdtempSync(join(tmpdir(), "fswatch-gone-"));
    roots.push(root);
    const sent: Frame[] = [];
    const ctx = { broadcastToAll: (m: unknown) => void sent.push(m as Frame) } as unknown as AppContext;

    // The OLDEST is alive and must survive; a younger one is deleted from disk
    // and is the one that has to go.
    const oldest = project(root, "oldest");
    armed(ctx, oldest);
    const gone = project(root, "gone");
    armed(ctx, gone);
    for (let i = 2; i < MAX_WATCHERS; i++) armed(ctx, project(root, `p${i}`));
    rmSync(gone, { recursive: true, force: true });

    const newest = project(root, "newest");
    armed(ctx, newest);

    // WHICH slot was freed is in the registry, so this reads it there. Asking
    // the same question through a `files:changed` made the answer depend on
    // how long twenty-five recursive watchers take to hand over one event on a
    // loaded machine: red at 6 s, then red again at 30 s, both times on cards
    // that had not touched the watcher (2026-09-06, 2026-09-07). The budget
    // above is what covers the test that still waits for an event; this one no
    // longer spends it. What a broadcast really proves - that a watcher past
    // the cap fires at all - is the test above.
    const watching = watchedProjectPaths();
    expect(watching, "the deleted project gives its slot up").not.toContain(gone);
    expect(watching, "the oldest live project keeps its watcher").toContain(oldest);
    expect(watching, "the project past the cap got the freed slot").toContain(newest);
  });
});
