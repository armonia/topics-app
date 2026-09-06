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
import { MAX_WATCHERS, unwatchProjectFiles, watchProjectFiles } from "./file-watcher";
import type { AppContext } from "./types";

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
async function until(cond: () => boolean, budgetMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await Bun.sleep(25);
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

    writeFileSync(join(last, "a.txt"), "uno\n");
    const arrived = await until(() => sent.some(f => f.type === "files:changed" && f.projectPath === last));
    expect(arrived, "the twenty-fifth project must broadcast like the first").toBe(true);
  });

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

    writeFileSync(join(oldest, "still.txt"), "qui\n");
    const alive = await until(() => sent.some(f => f.type === "files:changed" && f.projectPath === oldest));
    expect(alive, "the oldest live project keeps its watcher").toBe(true);
  });
});
