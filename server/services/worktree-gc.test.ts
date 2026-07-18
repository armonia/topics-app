/**
 * The worktree-GC safety contract. The decision function must NEVER return a
 * destructive action when there is anything to lose; the sweep must honour a
 * live turn and degrade to keep on a landing that can't complete.
 */
import { describe, test, expect } from "bun:test";
import { decideWorktreeReap, sweepWorktrees, type GcWorktree, type WorktreeGcDeps } from "./worktree-gc";

describe("decideWorktreeReap — safety contract", () => {
  const base = {
    taskStatus: "done" as const,
    taskArchived: false,
    hasRealDirt: false,
    mergedIntoMain: true,
    autoMergeEnabled: true,
    mode: "branch" as const,
  };

  test("done + clean + merged → reap", () => {
    expect(decideWorktreeReap(base).action).toBe("reap");
  });

  test("orphan (no task) + clean + merged → reap", () => {
    expect(decideWorktreeReap({ ...base, taskStatus: null }).action).toBe("reap");
  });

  test("archived task (any status) + clean + merged → reap", () => {
    expect(decideWorktreeReap({ ...base, taskStatus: "review", taskArchived: true }).action).toBe("reap");
  });

  for (const s of ["backlog", "todo", "in_progress", "review"] as const) {
    test(`active task '${s}' → keep even if clean+merged`, () => {
      expect(decideWorktreeReap({ ...base, taskStatus: s }).action).toBe("keep");
    });
  }

  test("real uncommitted dirt → keep (never destroy the only copy)", () => {
    expect(decideWorktreeReap({ ...base, hasRealDirt: true, mergedIntoMain: false }).action).toBe("keep");
  });

  test("done + clean + UNMERGED + automerge on + branch → land-then-reap", () => {
    expect(decideWorktreeReap({ ...base, mergedIntoMain: false }).action).toBe("land-then-reap");
  });

  test("done + clean + UNMERGED + automerge OFF → keep (human decides)", () => {
    expect(decideWorktreeReap({ ...base, mergedIntoMain: false, autoMergeEnabled: false }).action).toBe("keep");
  });

  test("done + clean + UNMERGED + non-branch mode → keep (nothing to land)", () => {
    expect(decideWorktreeReap({ ...base, mergedIntoMain: false, mode: "reuse" }).action).toBe("keep");
  });

  test("dirt beats merged: closed task with dirt is kept", () => {
    expect(decideWorktreeReap({ ...base, hasRealDirt: true }).action).toBe("keep");
  });
});

// ── sweep orchestration ──────────────────────────────────────────────────

function wt(id: string, over: Partial<GcWorktree> = {}): GcWorktree {
  return { id, projectId: "p", absPath: `/tmp/${id}`, branchName: `topics/${id}`, mode: "branch", ...over };
}

function makeDeps(over: Partial<WorktreeGcDeps> = {}): WorktreeGcDeps {
  return {
    listWorktrees: () => [],
    resolveTask: () => ({ taskId: "t", status: "done", archived: false }),
    isBusy: () => false,
    diskPresent: () => true,
    realDirt: async () => [],
    branchStatus: async () => "merged",
    autoMergeEnabled: () => true,
    tryLand: async () => "landed",
    reap: async () => true,
    log: () => {},
    ...over,
  };
}

describe("sweepWorktrees", () => {
  test("reaps a done+clean+merged worktree", async () => {
    const reaped: string[] = [];
    const s = await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("a")],
      reap: async (id) => { reaped.push(id); return true; },
    }));
    expect(reaped).toEqual(["a"]);
    expect(s.reaped).toBe(1);
  });

  test("never reaps under a live turn", async () => {
    const reaped: string[] = [];
    const s = await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("busy")],
      isBusy: () => true,
      reap: async (id) => { reaped.push(id); return true; },
    }));
    expect(reaped).toEqual([]);
    expect(s.kept).toBe(1);
  });

  test("lands unmerged clean commits before reaping", async () => {
    const calls: string[] = [];
    const s = await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("unmerged")],
      branchStatus: async () => "unmerged",
      tryLand: async (id) => { calls.push(`land:${id}`); return "landed"; },
      reap: async (id) => { calls.push(`reap:${id}`); return true; },
      resolveTask: () => ({ taskId: "t9", status: "done", archived: false }),
    }));
    // Land is keyed by taskId, reap by worktreeId, and land MUST come first.
    expect(calls).toEqual(["land:t9", "reap:unmerged"]);
    expect(s.landed).toBe(1);
    expect(s.reaped).toBe(1);
  });

  test("a merge conflict keeps the worktree (no reap)", async () => {
    const reaped: string[] = [];
    const s = await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("conflicted")],
      branchStatus: async () => "unmerged",
      tryLand: async () => "conflict",
      reap: async (id) => { reaped.push(id); return true; },
    }));
    expect(reaped).toEqual([]);
    expect(s.kept).toBe(1);
  });

  test("ghost row: branch already gone → reap directly (no land attempt)", async () => {
    const calls: string[] = [];
    const s = await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("ghost")],
      branchStatus: async () => "gone",
      tryLand: async (id) => { calls.push(`land:${id}`); return "skipped"; },
      reap: async (id) => { calls.push(`reap:${id}`); return true; },
    }));
    expect(calls).toEqual(["reap:ghost"]); // reaped, never tried to land
    expect(s.reaped).toBe(1);
  });

  test("disk gone + branch merged → reap (nothing on disk to lose)", async () => {
    const reaped: string[] = [];
    const s = await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("removed")],
      diskPresent: () => false,
      realDirt: async () => { throw new Error("must not stat a gone dir"); },
      branchStatus: async () => "merged",
      reap: async (id) => { reaped.push(id); return true; },
    }));
    expect(reaped).toEqual(["removed"]);
    expect(s.reaped).toBe(1);
  });

  test("orphan (no task) + unmerged → keep (can't land without a task)", async () => {
    const reaped: string[] = [];
    const s = await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("orphan-unmerged")],
      resolveTask: () => ({ taskId: null }),
      branchStatus: async () => "unmerged",
      reap: async (id) => { reaped.push(id); return true; },
    }));
    expect(reaped).toEqual([]);
    expect(s.kept).toBe(1);
  });

  test("keeps an active task's worktree", async () => {
    const s = await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("active")],
      resolveTask: () => ({ taskId: "t", status: "in_progress", archived: false }),
      reap: async () => { throw new Error("must not reap"); },
    }));
    expect(s.kept).toBe(1);
    expect(s.reaped).toBe(0);
  });

  test("one worktree failing does not abort the rest", async () => {
    const reaped: string[] = [];
    const s = await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("boom"), wt("ok")],
      realDirt: async (p) => { if (p.endsWith("boom")) throw new Error("git hiccup"); return []; },
      reap: async (id) => { reaped.push(id); return true; },
    }));
    // "boom" realDirt throws → caught → treated as clean → still reaps; both reaped.
    expect(reaped.sort()).toEqual(["boom", "ok"]);
    expect(s.reaped).toBe(2);
  });
});
