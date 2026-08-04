/**
 * The worktree-GC safety contract. The decision function must NEVER return a
 * destructive action when there is anything to lose; the sweep must honour a
 * live turn and degrade to keep on a landing that can't complete.
 */
import { describe, test, it, expect } from "bun:test";
import { decidePostLandReap, decideWorktreeReap, normalizeKeepReason, sweepWorktrees, type GcWorktree, type WorktreeGcDeps } from "./worktree-gc";

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

describe("decidePostLandReap — verify before destroy", () => {
  const base = { outcome: "landed" as const, branchAfter: "merged" as const, dirtAfter: [] as string[] };

  test("landed + content verified on main → reap", () => {
    expect(decidePostLandReap(base).action).toBe("reap");
  });

  test("branch deleted by the land itself → reap (no branch left to lose)", () => {
    expect(decidePostLandReap({ ...base, branchAfter: "gone" }).action).toBe("reap");
  });

  // THE REGRESSION. 2026-07-19: tryLand said "nothing", the branch was reaped,
  // 139 lines survived only in the reflog.
  test("land 'nothing' but branch still UNMERGED → keep, never reap", () => {
    const d = decidePostLandReap({ ...base, outcome: "nothing", branchAfter: "unmerged" });
    expect(d.action).toBe("keep");
    expect(d.reason).toContain("NON risulta su main");
  });

  test("land 'landed' but branch still UNMERGED → keep (the claim was wrong)", () => {
    expect(decidePostLandReap({ ...base, branchAfter: "unmerged" }).action).toBe("keep");
  });

  test("uncommitted work in the tree beats a successful land → keep (task e8780726)", () => {
    const d = decidePostLandReap({ ...base, dirtAfter: ["server/foo.ts"] });
    expect(d.action).toBe("keep");
    expect(d.reason).toContain("non committate");
  });

  for (const outcome of ["conflict", "skipped"] as const) {
    test(`land '${outcome}' → keep even if the branch reads merged`, () => {
      expect(decidePostLandReap({ ...base, outcome }).action).toBe("keep");
    });
  }
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
    let landed = false;
    const s = await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("unmerged")],
      // Unmerged before the land, merged after it — the post-land re-read is
      // what earns the reap.
      branchStatus: async () => (landed ? "merged" : "unmerged"),
      tryLand: async (id) => { calls.push(`land:${id}`); landed = true; return "landed"; },
      reap: async (id) => { calls.push(`reap:${id}`); return true; },
      resolveTask: () => ({ taskId: "t9", status: "done", archived: false }),
    }));
    // Land is keyed by taskId, reap by worktreeId, and land MUST come first.
    expect(calls).toEqual(["land:t9", "reap:unmerged"]);
    expect(s.landed).toBe(1);
    expect(s.reaped).toBe(1);
  });

  // The 2026-07-19 regression, end to end through the sweep.
  test("land says 'nothing' but the branch is still unmerged → keep + note on the task", async () => {
    const reaped: string[] = [];
    const notes: Array<[string, string]> = [];
    const s = await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("purple-finch")],
      branchStatus: async () => "unmerged", // still unmerged AFTER the land
      tryLand: async () => "nothing",
      reap: async (id) => { reaped.push(id); return true; },
      noteOnTask: (taskId, msg) => notes.push([taskId, msg]),
      resolveTask: () => ({ taskId: "b01711ff", status: "done", archived: false }),
    }));
    expect(reaped).toEqual([]);
    expect(s.kept).toBe(1);
    expect(notes).toHaveLength(1);
    expect(notes[0][0]).toBe("b01711ff");
    expect(notes[0][1]).toContain("topics/purple-finch");
  });

  test("land succeeded but dirt appeared in the tree → keep (uncommitted work wins)", async () => {
    const reaped: string[] = [];
    let landed = false;
    const s = await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("dirty-after")],
      // Clean at decision time, dirty when re-read after the land.
      realDirt: async () => (landed ? ["server/foo.ts"] : []),
      branchStatus: async () => (landed ? "merged" : "unmerged"),
      tryLand: async () => { landed = true; return "landed"; },
      reap: async (id) => { reaped.push(id); return true; },
    }));
    expect(reaped).toEqual([]);
    expect(s.kept).toBe(1);
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

/**
 * Il TTL sugli abbandonati. È l'unico punto in cui la GC tocca un task che sulla
 * carta è ATTIVO, quindi ogni condizione è scritta come "un motivo per non
 * toccarlo": basta che una non sia soddisfatta e si tiene tutto.
 */
describe("decideWorktreeReap — TTL sui task abbandonati in in_progress", () => {
  const stuck = {
    taskStatus: "in_progress" as const,
    taskArchived: false,
    hasRealDirt: false,
    mergedIntoMain: false,
    autoMergeEnabled: true,
    mode: "branch" as const,
    idleDays: 30,
    abandonAfterDays: 7,
  };

  test("fermo da 30 giorni con TTL a 7 → abandon (checkout via, branch salvo)", () => {
    const d = decideWorktreeReap(stuck);
    expect(d.action).toBe("abandon");
    expect(d.reason).toContain("30 giorni");
  });

  test("mai 'reap': l'abbandono non distrugge mai un branch", () => {
    // Anche col contenuto già su main la strada resta abandon: è il task che
    // decide, e un task in_progress non è chiuso.
    expect(decideWorktreeReap({ ...stuck, mergedIntoMain: true }).action).toBe("abandon");
  });

  test("fermo MENO del TTL → keep", () => {
    expect(decideWorktreeReap({ ...stuck, idleDays: 6.9 }).action).toBe("keep");
  });

  test("idle non misurabile (null) → keep: non saperlo non è essere morti", () => {
    expect(decideWorktreeReap({ ...stuck, idleDays: null }).action).toBe("keep");
  });

  test("TTL spento (0 o assente) → keep, qualunque sia l'idle", () => {
    expect(decideWorktreeReap({ ...stuck, abandonAfterDays: 0 }).action).toBe("keep");
    expect(decideWorktreeReap({ ...stuck, abandonAfterDays: undefined }).action).toBe("keep");
  });

  test("lavoro non committato → keep: quella è l'unica copia", () => {
    expect(decideWorktreeReap({ ...stuck, hasRealDirt: true }).action).toBe("keep");
  });

  test("mode 'detached' → keep: senza branch i commit diventerebbero irraggiungibili", () => {
    expect(decideWorktreeReap({ ...stuck, mode: "detached" }).action).toBe("keep");
  });

  test("mode 'reuse' → abandon: il branch preesistente tiene i commit", () => {
    expect(decideWorktreeReap({ ...stuck, mode: "reuse" }).action).toBe("abandon");
  });

  for (const s of ["backlog", "todo", "review"] as const) {
    test(`'${s}' fermo da 30 giorni → keep (solo in_progress mente sul suo stato)`, () => {
      expect(decideWorktreeReap({ ...stuck, taskStatus: s }).action).toBe("keep");
    });
  }

  test("un task chiuso segue la strada di sempre, il TTL non c'entra", () => {
    expect(decideWorktreeReap({ ...stuck, taskStatus: "done", mergedIntoMain: true }).action).toBe("reap");
  });
});

describe("sweepWorktrees — abbandonati", () => {
  const stuckDeps = (over: Partial<WorktreeGcDeps> = {}): WorktreeGcDeps =>
    makeDeps({
      listWorktrees: () => [wt("stuck")],
      resolveTask: () => ({ taskId: "t-stuck", status: "in_progress", archived: false }),
      branchStatus: async () => "unmerged",
      abandonAfterDays: 7,
      idleDays: () => 30,
      ...over,
    });

  test("chiama abandon col task, il worktree e il motivo — e non reapa nulla", async () => {
    const calls: Array<{ taskId: string; wtId: string; reason: string }> = [];
    const reaped: string[] = [];
    const s = await sweepWorktrees(stuckDeps({
      abandon: async (taskId, w, reason) => { calls.push({ taskId, wtId: w.id, reason }); return true; },
      reap: async (id) => { reaped.push(id); return true; },
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.taskId).toBe("t-stuck");
    expect(calls[0]!.wtId).toBe("stuck");
    expect(calls[0]!.reason).toContain("30 giorni");
    expect(reaped).toEqual([]);           // MAI la strada distruttiva
    expect(s.abandoned).toBe(1);
    expect(s.reaped).toBe(0);
  });

  test("host senza 'abandon' → keep (nessun mezzo abbandono: o park+rimozione, o niente)", async () => {
    const s = await sweepWorktrees(stuckDeps({ abandon: undefined }));
    expect(s.abandoned).toBe(0);
    expect(s.kept).toBe(1);
  });

  test("abandon che fallisce → kept, non contato", async () => {
    const s = await sweepWorktrees(stuckDeps({ abandon: async () => false }));
    expect(s.abandoned).toBe(0);
    expect(s.kept).toBe(1);
  });

  test("turno VIVO addosso → nemmeno interrogato l'idle", async () => {
    let asked = 0;
    const s = await sweepWorktrees(stuckDeps({
      isBusy: () => true,
      idleDays: () => { asked++; return 30; },
      abandon: async () => true,
    }));
    expect(asked).toBe(0);
    expect(s.abandoned).toBe(0);
    expect(s.kept).toBe(1);
  });

  test("dirt nel tree → keep, l'abbandono non passa sopra il lavoro non committato", async () => {
    const s = await sweepWorktrees(stuckDeps({
      realDirt: async () => ["server/foo.ts"],
      abandon: async () => true,
    }));
    expect(s.abandoned).toBe(0);
    expect(s.kept).toBe(1);
  });

  test("l'idle si misura solo per i candidati veri (in_progress)", async () => {
    const asked: string[] = [];
    await sweepWorktrees(stuckDeps({
      resolveTask: () => ({ taskId: "t-review", status: "review", archived: false }),
      idleDays: (id) => { asked.push(id); return 30; },
      abandon: async () => true,
    }));
    expect(asked).toEqual([]);
  });
});

describe("sweepWorktrees — riga fantasma sotto un task ancora attivo", () => {
  const ghost = (over: Partial<WorktreeGcDeps> = {}): WorktreeGcDeps =>
    makeDeps({
      listWorktrees: () => [wt("ghost")],
      branchStatus: async () => "gone",
      resolveTask: () => ({ taskId: "t-live", status: "in_progress", archived: false }),
      ...over,
    });

  test("task attivo + branch sparito → park, non una riga cancellata sotto i piedi", async () => {
    const calls: string[] = [];
    const reaped: string[] = [];
    const s = await sweepWorktrees(ghost({
      abandon: async (taskId, _w, reason) => { calls.push(`${taskId}:${reason}`); return true; },
      reap: async (id) => { reaped.push(id); return true; },
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("t-live");
    expect(reaped).toEqual([]);
    expect(s.abandoned).toBe(1);
  });

  test("task chiuso + branch sparito → resta il reap diretto di sempre", async () => {
    const reaped: string[] = [];
    const s = await sweepWorktrees(ghost({
      resolveTask: () => ({ taskId: "t-done", status: "done", archived: false }),
      abandon: async () => true,
      reap: async (id) => { reaped.push(id); return true; },
    }));
    expect(reaped).toEqual(["ghost"]);
    expect(s.reaped).toBe(1);
    expect(s.abandoned).toBe(0);
  });

  test("orfana (nessun task) + branch sparito → reap diretto", async () => {
    const reaped: string[] = [];
    const s = await sweepWorktrees(ghost({
      resolveTask: () => ({ taskId: null }),
      abandon: async () => true,
      reap: async (id) => { reaped.push(id); return true; },
    }));
    expect(reaped).toEqual(["ghost"]);
    expect(s.reaped).toBe(1);
  });
});

// ── I motivi dei kept ───────────────────────────────────────────────────────
//
// «38 kept» non è un'informazione: un accumulo legittimo (lavoro non ancora
// landato) e uno patologico (righe fantasma, decisioni bloccate) danno lo
// stesso numero. Il motivo veniva calcolato e buttato via.
describe("sweepWorktrees — perché i kept sono tenuti", () => {
  const wt = (id: string, over: Partial<GcWorktree> = {}): GcWorktree => ({
    id, projectId: "p1", absPath: `/tmp/${id}`, branchName: `topics/${id}`, mode: "branch", ...over,
  });

  function deps(over: Partial<WorktreeGcDeps> & { worktrees: GcWorktree[] }): WorktreeGcDeps {
    const { worktrees, ...rest } = over;
    return {
      listWorktrees: () => worktrees,
      resolveTask: (id) => ({ taskId: `t-${id}`, status: "in_progress", archived: false }),
      isBusy: () => false,
      branchStatus: async () => "unmerged",
      diskPresent: () => true,
      realDirt: async () => [],
      autoMergeEnabled: () => false,
      reap: async () => true,
      tryLand: async () => "landed",
      log: () => {},
      ...rest,
    } as WorktreeGcDeps;
  }

  it("raggruppa i kept per motivo, non solo li conta", async () => {
    const s = await sweepWorktrees(deps({
      worktrees: [wt("a"), wt("b"), wt("c")],
      resolveTask: (id) => ({
        taskId: `t-${id}`,
        status: id === "c" ? "review" : "in_progress",
        archived: false,
      }),
    }));
    expect(s.kept).toBe(3);
    expect(s.keptReasons["task 'in_progress' attivo"]).toBe(2);
    expect(s.keptReasons["task 'review' attivo"]).toBe(1);
  });

  it("un turno in corso è un motivo, non un keep muto", async () => {
    const s = await sweepWorktrees(deps({ worktrees: [wt("a")], isBusy: () => true }));
    expect(s.kept).toBe(1);
    expect(s.keptReasons["turno in corso sul task"]).toBe(1);
  });

  it("i numeri variabili si normalizzano, o ogni worktree sarebbe una categoria a sé", async () => {
    const s = await sweepWorktrees(deps({
      worktrees: [wt("a"), wt("b")],
      resolveTask: (id) => ({ taskId: `t-${id}`, status: "done", archived: false }),
      realDirt: async (p) => (p.endsWith("a") ? ["x.ts"] : ["y.ts", "z.ts"]),
    }));
    // Due worktree, quantità di sporco diverse, UNA categoria.
    expect(Object.keys(s.keptReasons)).toEqual(["modifiche non committate (junk escluso)"]);
    expect(s.keptReasons["modifiche non committate (junk escluso)"]).toBe(2);
  });

  it("la somma dei motivi torna sempre col totale dei kept", async () => {
    const s = await sweepWorktrees(deps({
      worktrees: [wt("a"), wt("b"), wt("c"), wt("d")],
      resolveTask: (id) => ({ taskId: `t-${id}`, status: id === "d" ? "todo" : "in_progress", archived: false }),
    }));
    const somma = Object.values(s.keptReasons).reduce((n, v) => n + v, 0);
    expect(somma).toBe(s.kept);
  });

  it("nessun kept ⇒ nessun motivo (non una categoria vuota)", async () => {
    const s = await sweepWorktrees(deps({
      worktrees: [wt("a")],
      resolveTask: () => ({ taskId: "t", status: "done", archived: false }),
      branchStatus: async () => "merged",
    }));
    expect(s.reaped).toBe(1);
    expect(s.keptReasons).toEqual({});
  });
});

describe("normalizeKeepReason", () => {
  it("toglie i numeri", () => {
    expect(normalizeKeepReason("task fermo in 'in_progress' da 9 giorni"))
      .toBe(normalizeKeepReason("task fermo in 'in_progress' da 12 giorni"));
  });

  it("TIENE gli stati fra apici: sono l'informazione utile", () => {
    // «tenuti perché in review» e «tenuti perché in backlog» chiedono due azioni
    // diverse: collassarli renderebbe il riepilogo inutile.
    expect(normalizeKeepReason("task 'review' attivo"))
      .not.toBe(normalizeKeepReason("task 'backlog' attivo"));
  });
});
