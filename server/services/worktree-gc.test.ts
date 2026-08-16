/**
 * The worktree-GC safety contract. The decision function must NEVER return a
 * destructive action when there is anything to lose; the sweep must honour a
 * live turn and degrade to keep on a landing that can't complete.
 */
import { describe, test, it, expect } from "bun:test";
import { decideGhostRow, decidePostLandReap, decideWorktreeReap, normalizeKeepReason, shouldSlimOnKeep, sweepWorktrees, type GcWorktree, type WorktreeGcDeps } from "./worktree-gc";

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

  // I COMMIT restano da decidere a mano; la CARTELLA no. Il branch li tiene
  // raggiungibili, quindi il checkout è una copia — e 77 copie da ~400 MB sono
  // i 33,9 GB che questa riga, dicendo `keep`, difendeva.
  test("done + clean + UNMERGED + automerge OFF → free-checkout (branch conservato)", () => {
    const d = decideWorktreeReap({ ...base, mergedIntoMain: false, autoMergeEnabled: false });
    expect(d.action).toBe("free-checkout");
    expect(d.reason).toContain("branch conservato");
  });

  test("done + clean + UNMERGED + branch SPARITO → keep (la cartella è l'unica copia)", () => {
    expect(
      decideWorktreeReap({ ...base, mergedIntoMain: false, autoMergeEnabled: false, branchGone: true }).action,
    ).toBe("keep");
  });

  test("done + clean + UNMERGED + non-branch mode → keep (nothing to land)", () => {
    expect(decideWorktreeReap({ ...base, mergedIntoMain: false, mode: "reuse" }).action).toBe("keep");
  });

  test("detached: i commit vivono solo nell'HEAD della cartella → keep", () => {
    expect(
      decideWorktreeReap({ ...base, mergedIntoMain: false, autoMergeEnabled: false, mode: "detached" }).action,
    ).toBe("keep");
  });

  test("free-checkout non distrugge MAI un branch: nessun input pulito+non-mergiato produce 'reap'", () => {
    for (const mode of ["branch", "reuse", "detached"] as const) {
      for (const autoMergeEnabled of [true, false]) {
        for (const branchGone of [true, false]) {
          const d = decideWorktreeReap({ ...base, mergedIntoMain: false, mode, autoMergeEnabled, branchGone });
          expect(d.action).not.toBe("reap");
        }
      }
    }
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
  // 139 lines survived only in the reflog. Il branch resta intoccabile — è la
  // CARTELLA che ora può andarsene, ed è una cosa diversa.
  test("land 'nothing' but branch still UNMERGED → mai reap; cartella libera, branch salvo", () => {
    const d = decidePostLandReap({ ...base, outcome: "nothing", branchAfter: "unmerged" });
    expect(d.action).toBe("free-checkout");
    expect(d.action).not.toBe("reap");
    expect(d.reason).toContain("NON risulta su main");
    expect(d.reason).toContain("branch conservato");
  });

  test("land 'landed' but branch still UNMERGED → mai reap (the claim was wrong)", () => {
    const d = decidePostLandReap({ ...base, branchAfter: "unmerged" });
    expect(d.action).toBe("free-checkout");
    expect(d.action).not.toBe("reap");
  });

  test("uncommitted work in the tree beats a successful land → keep (task e8780726)", () => {
    const d = decidePostLandReap({ ...base, dirtAfter: ["server/foo.ts"] });
    expect(d.action).toBe("keep");
    expect(d.reason).toContain("non committate");
  });

  for (const outcome of ["conflict", "skipped"] as const) {
    // Il land non è avvenuto: i commit vivono solo sul branch, che non si tocca.
    // La cartella invece è ridondante, e da `03ca44c3` questo è il caso NORMALE
    // (il land rifiuta ogni branch che porti commit di un'altra sessione).
    test(`land '${outcome}' → free-checkout, mai reap`, () => {
      const d = decidePostLandReap({ ...base, outcome });
      expect(d.action).toBe("free-checkout");
      expect(d.action).not.toBe("reap");
    });

    test(`land '${outcome}' con lavoro non committato → keep, la cartella è l'unica copia`, () => {
      expect(decidePostLandReap({ ...base, outcome, dirtAfter: ["client/x.tsx"] }).action).toBe("keep");
    });

    test(`land '${outcome}' e branch sparito → keep, la cartella è l'ultimo appiglio`, () => {
      const d = decidePostLandReap({ ...base, outcome, branchAfter: "gone" });
      expect(d.action).toBe("keep");
      expect(d.reason).toContain("unica copia");
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
    realDirt: async () => ({ ok: true, paths: [] }),
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

  // Stessa bugia del task `5770b9de`, vista dal lato del land: il keep nasce
  // dallo sporco nel tree, ma il branch è già stato cancellato dal land — la
  // nota NON deve dire «è stato conservato» di un ref che non c'è più.
  test("keep con branch già sparito → la nota non promette un branch conservato", async () => {
    const notes: Array<[string, string]> = [];
    let landed = false;
    await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("gone-after")],
      realDirt: async () => ({ ok: true, paths: landed ? ["server/foo.ts"] : [] }),
      branchStatus: async () => (landed ? "gone" : "unmerged"),
      tryLand: async () => { landed = true; return "landed"; },
      noteOnTask: (taskId, msg) => notes.push([taskId, msg]),
      resolveTask: () => ({ taskId: "t-gone", status: "done", archived: false }),
    }));
    expect(notes).toHaveLength(1);
    expect(notes[0][1]).toContain("NON è più nel repo");
    expect(notes[0][1]).not.toContain("è stato conservato");
  });

  test("keep con branch ancora presente → la nota dice che è stato conservato", async () => {
    const notes: Array<[string, string]> = [];
    await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("kept-branch")],
      branchStatus: async () => "unmerged",
      tryLand: async () => "nothing",
      noteOnTask: (taskId, msg) => notes.push([taskId, msg]),
      resolveTask: () => ({ taskId: "t-kept", status: "done", archived: false }),
    }));
    expect(notes[0][1]).toContain("è stato conservato");
  });

  test("land succeeded but dirt appeared in the tree → keep (uncommitted work wins)", async () => {
    const reaped: string[] = [];
    let landed = false;
    const s = await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("dirty-after")],
      // Clean at decision time, dirty when re-read after the land.
      realDirt: async () => ({ ok: true, paths: landed ? ["server/foo.ts"] : [] }),
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

  // Una sonda che non risponde NON e' una sonda che dice «pulito». Il caso
  // rotto: `git status` esce non-zero (index.lock, volume che non risponde) o
  // esplode, e prima quella cartella veniva CANCELLATA come se fosse vuota —
  // il guard piu' importante del GC falliva aperto, esattamente al contrario di
  // come deve fallire un guard che autorizza a distruggere.
  test("una worktree illeggibile si tiene, e non ferma le altre", async () => {
    const reaped: string[] = [];
    const s = await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("boom"), wt("ok")],
      realDirt: async (p) => {
        if (p.endsWith("boom")) throw new Error("git hiccup");
        return { ok: true, paths: [] };
      },
      reap: async (id) => { reaped.push(id); return true; },
    }));
    expect(reaped).toEqual(["ok"]);
    expect(s.reaped).toBe(1);
    expect(s.kept).toBe(1);
  });

  // Stessa cosa senza eccezione: `git status` che esce non-zero e' il caso
  // COMUNE (repo occupato), e arriva come `ok: false`, non come throw.
  test("git status non-zero vale sporco, non pulito", async () => {
    const reaped: string[] = [];
    const s = await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("muta")],
      realDirt: async () => ({ ok: false, paths: [] }),
      reap: async (id) => { reaped.push(id); return true; },
    }));
    expect(reaped).toEqual([]);
    expect(s.kept).toBe(1);
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
      realDirt: async () => ({ ok: true, paths: ["server/foo.ts"] }),
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

  // IL GUASTO DEL 12/08. Quattro card in `review` — d6baaf5e, 3bde1ab0, c8ea8173,
  // 5472e584 — sono finite in backlog marcate `failed` nella stessa ora, con la
  // stessa riga «il branch del worktree non esiste più». Nessuna aveva fallito:
  // il land aveva potato il loro ramo. Il park le toglieva dalla colonna dove
  // l'umano guarda, e il backlog non lo dispaccia nessuno.
  test("card in review + branch sparito → si scioglie il legame, MAI un park", async () => {
    const parked: string[] = [];
    const unbound: string[] = [];
    const s = await sweepWorktrees(ghost({
      resolveTask: () => ({ taskId: "d6baaf5e", status: "review", archived: false }),
      abandon: async (taskId) => { parked.push(taskId); return true; },
      unbind: async (taskId, _w, reason) => { unbound.push(`${taskId}:${reason}`); return true; },
    }));
    expect(parked).toEqual([]);
    expect(unbound).toEqual(["d6baaf5e:il branch del worktree non esiste più"]);
    expect(s.unbound).toBe(1);
    expect(s.abandoned).toBe(0);
  });

  test("consegna già su main → non è un fallimento, qualunque sia la colonna", async () => {
    const parked: string[] = [];
    const unbound: Array<{ reason: string; landed: boolean }> = [];
    const s = await sweepWorktrees(ghost({
      resolveTask: () => ({ taskId: "t-landed", status: "in_progress", archived: false }),
      deliveryLanded: async () => true,
      abandon: async (taskId) => { parked.push(taskId); return true; },
      unbind: async (_t, _w, reason, landed) => { unbound.push({ reason, landed }); return true; },
    }));
    expect(parked).toEqual([]);
    expect(unbound).toEqual([{ reason: "il ramo è stato potato dopo un atterraggio riuscito", landed: true }]);
    expect(s.unbound).toBe(1);
  });

  // `null` non è `false`: non aver potuto guardare non prova un atterraggio, e
  // un task che dichiara di starci lavorando dentro ha davvero perso la sessione.
  test("consegna non verificabile su un task attivo → park come sempre", async () => {
    const parked: string[] = [];
    const s = await sweepWorktrees(ghost({
      deliveryLanded: async () => null,
      abandon: async (taskId) => { parked.push(taskId); return true; },
      unbind: async () => { throw new Error("non deve slegare"); },
    }));
    expect(parked).toEqual(["t-live"]);
    expect(s.abandoned).toBe(1);
  });

  test("una sonda del land che esplode non declassa nessuno: vale come 'non so'", async () => {
    const parked: string[] = [];
    const s = await sweepWorktrees(ghost({
      deliveryLanded: async () => { throw new Error("git offline"); },
      abandon: async (taskId) => { parked.push(taskId); return true; },
    }));
    expect(parked).toEqual(["t-live"]);
    expect(s.errors).toBe(0);
  });

  test("host senza `unbind` → si TIENE la riga, non si ripiega sul park", async () => {
    const parked: string[] = [];
    const reaped: string[] = [];
    const s = await sweepWorktrees(ghost({
      resolveTask: () => ({ taskId: "t-review", status: "review", archived: false }),
      unbind: undefined,
      abandon: async (taskId) => { parked.push(taskId); return true; },
      reap: async (id) => { reaped.push(id); return true; },
    }));
    expect(parked).toEqual([]);
    expect(reaped).toEqual([]);
    expect(s.kept).toBe(1);
  });
});

describe("decideGhostRow", () => {
  const base = { taskStatus: "in_progress" as const, taskArchived: false, deliveryLanded: null };

  test("nessun task vivo → la riga è peso morto e basta", () => {
    expect(decideGhostRow({ ...base, taskStatus: null }).task).toBe("none");
    expect(decideGhostRow({ ...base, taskStatus: "done" }).task).toBe("none");
    expect(decideGhostRow({ ...base, taskArchived: true }).task).toBe("none");
  });

  test("consegna su main → unbind, e il motivo dice che è atterrata", () => {
    const d = decideGhostRow({ ...base, deliveryLanded: true });
    expect(d.task).toBe("unbind");
    expect(d.reason).toContain("atterraggio riuscito");
  });

  test("review → unbind anche quando il ramo è sparito davvero", () => {
    expect(decideGhostRow({ ...base, taskStatus: "review", deliveryLanded: false }).task).toBe("unbind");
    expect(decideGhostRow({ ...base, taskStatus: "review", deliveryLanded: null }).task).toBe("unbind");
  });

  test("un task che dichiara di lavorarci dentro si parcheggia come prima", () => {
    for (const s of ["backlog", "todo", "in_progress"] as const) {
      expect(decideGhostRow({ ...base, taskStatus: s }).task).toBe("park");
    }
  });

  // La regola 1 vince sulla 2, e l'ordine si vede solo qui: una card in review
  // la cui consegna È su main deve leggere «atterrato», non «il ramo non c'è».
  test("review + consegna su main → il motivo è l'atterraggio, non la sparizione", () => {
    expect(decideGhostRow({ ...base, taskStatus: "review", deliveryLanded: true }).reason)
      .toContain("atterraggio riuscito");
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
      realDirt: async () => ({ ok: true, paths: [] }),
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
      realDirt: async (p) => ({ ok: true, paths: p.endsWith("a") ? ["x.ts"] : ["y.ts", "z.ts"] }),
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

// ── snellimento dei worktree TENUTI ──────────────────────────────────────
//
// Il `keep` è la decisione giusta sui commit e sui file tracciati, ma per anni
// ha significato anche «resta piena»: una card consegnata aspetta un umano per
// giorni tenendosi ~260 MB di dipendenze. Qui si verifica che il `keep` continui
// a valere sui commit e smetta di valere sui MB.

describe("shouldSlimOnKeep", () => {
  it("una card consegnata o chiusa si snellisce", () => {
    expect(shouldSlimOnKeep("review", false)).toBe(true);
    expect(shouldSlimOnKeep("done", false)).toBe(true);
  });

  it("un orfano o un archiviato pure: nessuno li riaprirà", () => {
    expect(shouldSlimOnKeep(null, false)).toBe(true);
    expect(shouldSlimOnKeep("in_progress", true)).toBe(true);
  });

  it("chi è in coda o al lavoro NO — si riprenderebbe il bun install subito", () => {
    expect(shouldSlimOnKeep("in_progress", false)).toBe(false);
    expect(shouldSlimOnKeep("todo", false)).toBe(false);
    expect(shouldSlimOnKeep("backlog", false)).toBe(false);
  });
});

describe("sweepWorktrees — snellimento", () => {
  const inReview = (over: Partial<WorktreeGcDeps> = {}): WorktreeGcDeps =>
    makeDeps({
      listWorktrees: () => [wt("consegnato")],
      resolveTask: () => ({ taskId: "t-rev", status: "review", archived: false }),
      branchStatus: async () => "unmerged",
      ...over,
    });

  test("una card in review resta dov'è, ma perde gli artefatti", async () => {
    const slimmed: string[] = [];
    const s = await sweepWorktrees(inReview({
      slim: async (w) => { slimmed.push(w.id); return 260 * 1_048_576; },
      reap: async () => { throw new Error("non si deve reapare una card in review"); },
    }));
    expect(slimmed).toEqual(["consegnato"]);
    expect(s.kept).toBe(1);
    expect(s.slimmed).toBe(1);
    expect(s.slimmedBytes).toBe(260 * 1_048_576);
  });

  test("un turno VIVO ferma anche lo snellimento", async () => {
    const slimmed: string[] = [];
    const s = await sweepWorktrees(inReview({
      isBusy: () => true,
      slim: async (w) => { slimmed.push(w.id); return 1; },
    }));
    expect(slimmed).toEqual([]);
    expect(s.slimmed).toBe(0);
  });

  test("un task in_progress tenuto non si tocca: l'agent ci sta lavorando", async () => {
    const slimmed: string[] = [];
    const s = await sweepWorktrees(inReview({
      resolveTask: () => ({ taskId: "t-wip", status: "in_progress", archived: false }),
      slim: async (w) => { slimmed.push(w.id); return 1; },
    }));
    expect(slimmed).toEqual([]);
    expect(s.kept).toBe(1);
    expect(s.slimmed).toBe(0);
  });

  test("cartella non più sul disco → niente da snellire", async () => {
    const slimmed: string[] = [];
    await sweepWorktrees(inReview({
      diskPresent: () => false,
      slim: async (w) => { slimmed.push(w.id); return 1; },
    }));
    expect(slimmed).toEqual([]);
  });

  test("zero byte liberati non conta come snellimento", async () => {
    const s = await sweepWorktrees(inReview({ slim: async () => 0 }));
    expect(s.slimmed).toBe(0);
    expect(s.slimmedBytes).toBe(0);
  });

  test("uno slim che esplode non fa saltare la passata", async () => {
    const s = await sweepWorktrees(inReview({
      slim: async () => { throw new Error("permessi"); },
    }));
    expect(s.kept).toBe(1);
    expect(s.errors).toBe(0);
    expect(s.slimmed).toBe(0);
  });

  test("chi viene reapato non si snellisce prima: la cartella se ne va intera", async () => {
    const slimmed: string[] = [];
    const s = await sweepWorktrees(makeDeps({
      listWorktrees: () => [wt("chiuso")],
      slim: async (w) => { slimmed.push(w.id); return 1; },
    }));
    expect(s.reaped).toBe(1);
    expect(slimmed).toEqual([]);
  });

  test("free-checkout fallito → la cartella resta, e almeno si snellisce", async () => {
    const slimmed: string[] = [];
    const s = await sweepWorktrees(inReview({
      resolveTask: () => ({ taskId: "t-chiuso", status: "done", archived: false }),
      autoMergeEnabled: () => false,
      freeCheckout: async () => false,
      slim: async (w) => { slimmed.push(w.id); return 42; },
    }));
    expect(s.freed).toBe(0);
    expect(s.kept).toBe(1);
    expect(slimmed).toEqual(["consegnato"]);
  });

  test("host senza 'slim' → passata identica a prima, zero contati", async () => {
    const s = await sweepWorktrees(inReview({ slim: undefined }));
    expect(s.kept).toBe(1);
    expect(s.slimmed).toBe(0);
    expect(s.slimmedBytes).toBe(0);
  });
});
