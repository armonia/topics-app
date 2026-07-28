/**
 * The audit exists because a column said "done" while main said nothing. These
 * tests pin the two properties that make it trustworthy:
 *   • it must SHOUT once, on the edge into `unlanded` (not every 30 minutes);
 *   • it must never shout when it doesn't know (a pruned commit, an unreadable
 *     repo, a git error) — a false alarm burns the signal as fast as a miss.
 */
import { describe, it, expect } from "bun:test";
import { auditLandings, classifyLanding, type AuditTask, type LandingAuditDeps, type LandingState } from "./landing-audit";
import type { BranchStatus } from "./branch-status";

const task = (id: string, over: Partial<AuditTask> = {}): AuditTask => ({
  id, projectId: "p1", deliveryBranch: `topics/${id}`, deliveryCommit: `${id}0000000000000000000000000000000000`.slice(0, 40), ...over,
});

function harness(opts: {
  tasks: AuditTask[];
  status?: (commit: string) => BranchStatus | Promise<BranchStatus>;
  repo?: (projectId: string) => string | null;
  previous?: Record<string, LandingState>;
}) {
  const recorded: Array<{ id: string; state: LandingState; at: string }> = [];
  const alerts: AuditTask[] = [];
  const logs: string[] = [];
  const deps: LandingAuditDeps = {
    listCandidates: () => opts.tasks,
    repoPath: opts.repo ?? (() => "/repo"),
    commitStatus: async (_repo, commit) => (opts.status ? opts.status(commit) : "merged"),
    record: (id, state, at) => { recorded.push({ id, state, at }); },
    previousState: (id) => opts.previous?.[id] ?? null,
    onNewlyUnlanded: (t) => { alerts.push(t); },
    now: () => "2026-07-28T10:00:00.000Z",
    log: (m) => { logs.push(m); },
  };
  return { deps, recorded, alerts, logs };
}

describe("classifyLanding", () => {
  it("merged → landed", () => expect(classifyLanding("merged")).toBe("landed"));
  it("unmerged → unlanded", () => expect(classifyLanding("unmerged")).toBe("unlanded"));
  it("gone → unverifiable, NOT unlanded", () => {
    // A commit the repo no longer holds is a question we can't answer. Calling
    // it "unlanded" would flag every old task and teach the human to ignore the badge.
    expect(classifyLanding("gone")).toBe("unverifiable");
  });
});

describe("auditLandings", () => {
  it("stamps a verdict on every candidate with the same timestamp", async () => {
    const h = harness({ tasks: [task("a"), task("b")], status: () => "merged" });
    const s = await auditLandings(h.deps);
    expect(s).toEqual({ checked: 2, landed: 2, unlanded: 0, unverifiable: 0 });
    expect(h.recorded.map((r) => r.state)).toEqual(["landed", "landed"]);
    expect(new Set(h.recorded.map((r) => r.at)).size).toBe(1);
    expect(h.alerts).toHaveLength(0);
  });

  it("REGRESSION b01711ff: a delivered commit that is not on main fires the alert", async () => {
    const h = harness({ tasks: [task("b01711ff")], status: () => "unmerged" });
    const s = await auditLandings(h.deps);
    expect(s.unlanded).toBe(1);
    expect(h.recorded[0]!.state).toBe("unlanded");
    expect(h.alerts.map((t) => t.id)).toEqual(["b01711ff"]);
  });

  it("alerts only on the EDGE — a task already unlanded stays silent", async () => {
    const h = harness({ tasks: [task("a")], status: () => "unmerged", previous: { a: "unlanded" } });
    await auditLandings(h.deps);
    expect(h.recorded[0]!.state).toBe("unlanded"); // still recorded…
    expect(h.alerts).toHaveLength(0);              // …but no second shout
  });

  it("re-alerts when a task goes landed → unlanded again (branch re-opened)", async () => {
    const h = harness({ tasks: [task("a")], status: () => "unmerged", previous: { a: "landed" } });
    await auditLandings(h.deps);
    expect(h.alerts).toHaveLength(1);
  });

  it("a pruned commit is unverifiable and never alerts", async () => {
    const h = harness({ tasks: [task("old")], status: () => "gone" });
    const s = await auditLandings(h.deps);
    expect(s).toEqual({ checked: 1, landed: 0, unlanded: 0, unverifiable: 1 });
    expect(h.alerts).toHaveLength(0);
  });

  it("an unknown project resolves to unverifiable without touching git", async () => {
    let asked = 0;
    const h = harness({
      tasks: [task("x")],
      repo: () => null,
      status: () => { asked += 1; return "unmerged"; },
    });
    const s = await auditLandings(h.deps);
    expect(asked).toBe(0);
    expect(s.unverifiable).toBe(1);
    expect(h.alerts).toHaveLength(0);
  });

  it("a git failure on one task never aborts the sweep", async () => {
    const h = harness({
      tasks: [task("boom"), task("ok")],
      status: (commit) => { if (commit.startsWith("boom")) throw new Error("git exploded"); return "merged"; },
    });
    const s = await auditLandings(h.deps);
    expect(s.checked).toBe(1);      // the exploding one never got a verdict…
    expect(s.landed).toBe(1);       // …and the next task was still audited
    expect(s.unverifiable).toBe(1);
    expect(h.logs.some((l) => l.includes("git exploded"))).toBe(true);
  });

  it("skips tasks with no recorded delivery instead of guessing", async () => {
    const h = harness({ tasks: [task("a", { deliveryCommit: null })], status: () => "unmerged" });
    const s = await auditLandings(h.deps);
    expect(s.checked).toBe(0);
    expect(h.recorded).toHaveLength(0);
  });

  // REGRESSIONE: il wiring cercava `tasks.project_id` (l'id di BOARD, un hash
  // di percorso) dentro il ProjectStore, che indicizza per UUID. `repoPath`
  // tornava null per OGNI task e l'audit stampava `unverifiable` su tutto,
  // silenziosamente: un contatore che non ha mai verificato niente, esattamente
  // il fallimento che doveva intercettare. Un audit cieco deve dirlo.
  it("un audit che non risolve NIENTE lo dice nel log invece di tacere", async () => {
    const h = harness({ tasks: [task("a"), task("b"), task("c")], repo: () => null });
    const s = await auditLandings(h.deps);
    expect(s).toEqual({ checked: 3, landed: 0, unlanded: 0, unverifiable: 3 });
    expect(h.logs.some((l) => l.includes("3/3") && l.includes("non verificabili"))).toBe(true);
  });

  it("nessun rumore quando ogni verdetto è certo", async () => {
    const h = harness({ tasks: [task("a"), task("b")], status: () => "merged" });
    await auditLandings(h.deps);
    expect(h.logs).toHaveLength(0);
  });
});
