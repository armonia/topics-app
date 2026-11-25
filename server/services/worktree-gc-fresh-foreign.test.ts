/**
 * A checkout another tool just made (`topics-worktree add`, a bare `git worktree
 * add` seen by the post-checkout hook) is registered at once, with no lock and no
 * task, clean and on main: the exact shape the sweep removes. Topics sees neither
 * that tool's process nor its plans, so the row gets the same day an unregistered
 * orphan gets, in the sweep and in the per-project cap.
 *
 * @covers WORKTREE-STD-08
 */
import { describe, expect, test } from "bun:test";
import { registeredLately, sweepWorktrees, type GcWorktree, type WorktreeGcDeps } from "./worktree-gc";
import { capPass, type GcRow, type PassesCtx } from "./worktree-gc-passes";

const fresh = () => new Date(Date.now() - 5 * 60_000).toISOString();
const old = () => new Date(Date.now() - 25 * 3600_000).toISOString();

function wt(id: string, over: Partial<GcWorktree>): GcWorktree {
  return { id, projectId: "p", absPath: `/nowhere/${id}`, branchName: `worktree-${id}`, mode: "branch", ...over };
}

/** An orphan, clean, merged population: everything the contract would reap. */
function sweepDeps(rows: GcWorktree[], reaped: string[]): WorktreeGcDeps {
  return {
    listWorktrees: () => rows,
    resolveTask: () => ({ taskId: null }),
    isBusy: () => false,
    diskPresent: () => true,
    realDirt: async () => ({ ok: true, paths: [] }),
    branchStatus: async () => "merged",
    reap: async (id) => { reaped.push(id); return true; },
    log: () => {},
  } as WorktreeGcDeps;
}

describe("the day another tool's checkout gets", () => {
  test("registered by another creator less than 24 h ago: the sweep keeps it", async () => {
    const reaped: string[] = [];
    const s = await sweepWorktrees(sweepDeps([wt("codex-wt", { source: "codex", createdAt: fresh() })], reaped));
    expect(reaped).toEqual([]);
    expect(s.kept).toBe(1);
  });

  test("the same checkout a day later, and Topics' own fresh rows, are judged as always", async () => {
    const reaped: string[] = [];
    await sweepWorktrees(sweepDeps([
      wt("codex-old", { source: "codex", createdAt: old() }),
      wt("own-fresh", { source: "topics", createdAt: fresh() }),
    ], reaped));
    expect(reaped).toEqual(["codex-old", "own-fresh"]);
  });

  test("a date that does not parse reads as fresh", () => {
    expect(registeredLately({ source: "adopted", createdAt: "not a date" })).toBe(true);
    expect(registeredLately({ createdAt: "not a date" })).toBe(false);
  });

  test("the cap hands the sweep a row with its creator and its age", async () => {
    const seen: GcWorktree[] = [];
    const row = (id: string, over: Partial<GcRow>): GcRow => ({ id, projectId: "p", absPath: `/nowhere/${id}`, branchName: null, mode: "detached", status: "ready", ...over });
    const ctx = {
      readSettings: () => ({ abandonDays: 7, gcForeign: "off", maxPerProject: 1 }),
      rows: () => [row("a", { createdAt: old() }), row("b", { source: "codex", createdAt: fresh() })],
      isOurs: () => true,
      folderPresent: () => true,
      taskOf: () => ({ taskId: null }),
      isInFlight: () => false,
      liveInside: () => false,
      busyInside: () => false,
      slim: async () => {},
      sweepOne: async (w: GcWorktree) => {
        seen.push(w);
        return { total: 1, reaped: 0, archived: 0, abandoned: 0, unbound: 0, freed: 0, kept: 1, residueCommitted: 0, slimmed: 0, slimmedBytes: 0, errors: 0, keptReasons: {} };
      },
    } as unknown as PassesCtx;
    await capPass(ctx);
    expect(seen.map((w) => [w.id, registeredLately(w)])).toEqual([["a", false], ["b", true]]);
  });
});
