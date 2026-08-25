/**
 * The audit exists because a column said "done" while main said nothing. These
 * tests pin the two properties that make it trustworthy:
 *   • it must SHOUT once, on the edge into `unlanded` (not every 30 minutes);
 *   • it must never shout when it doesn't know (a pruned commit, an unreadable
 *     repo, a git error) — a false alarm burns the signal as fast as a miss.
 *
 * @covers LAND-05
 */
import { describe, it, expect } from "bun:test";
import { auditLandings, classifyLanding, classifyLandingEsito, type AuditTask, type LandingAuditDeps, type LandingState } from "./landing-audit";
import type { BranchStatus } from "./branch-status";

const task = (id: string, over: Partial<AuditTask> = {}): AuditTask => ({
  id, projectId: "p1", deliveryBranch: `topics/${id}`, deliveryCommit: `${id}0000000000000000000000000000000000`.slice(0, 40), ...over,
});

function harness(opts: {
  tasks: AuditTask[];
  status?: (commit: string) => BranchStatus | Promise<BranchStatus>;
  repo?: (projectId: string) => string | null;
  previous?: Record<string, LandingState>;
  debt?: (task: AuditTask) => LandingState | Promise<LandingState>;
  landedMerge?: (task: AuditTask) => boolean | null | Promise<boolean | null>;
}) {
  const recorded: Array<{ id: string; state: LandingState; at: string }> = [];
  const alerts: AuditTask[] = [];
  const logs: string[] = [];
  const deps: LandingAuditDeps = {
    listCandidates: () => opts.tasks,
    repoPath: opts.repo ?? (() => "/repo"),
    commitStatus: async (_repo, commit) => (opts.status ? opts.status(commit) : "merged"),
    ...(opts.debt ? { debtVerdict: async (t: AuditTask) => opts.debt!(t) } : {}),
    ...(opts.landedMerge ? { landedMerge: async (t: AuditTask) => opts.landedMerge!(t) } : {}),
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

/**
 * ACCUSARE È L'ULTIMA COSA CHE SI FA. Sulle 14 card che portavano la pastiglia
 * rossa il 13/08, tre erano state SUPERATE — quei file su main li aveva rifatti
 * qualcun altro, dopo — e per loro «landa il ramo» non è un'azione: non c'è
 * niente da recuperare, e il rosso costava solo la fiducia negli altri rossi.
 */
describe("classifyLandingEsito", () => {
  it("solo `fuori` è un debito: gli altri esiti non accusano", () => {
    expect(classifyLandingEsito("dentro")).toBe("landed");
    expect(classifyLandingEsito("fuori")).toBe("unlanded");
    expect(classifyLandingEsito("superato")).toBe("unverifiable");
    expect(classifyLandingEsito("non-decidibile")).toBe("unverifiable");
  });
});

describe("auditLandings", () => {
  it("la seconda domanda si paga solo su chi la prima dà per fuori", async () => {
    const chiesti: string[] = [];
    const h = harness({
      tasks: [task("dentro"), task("fuori")],
      status: (commit) => (commit.startsWith("dentro") ? "merged" : "unmerged"),
      debt: (t) => { chiesti.push(t.id); return "unverifiable"; },
    });
    const s = await auditLandings(h.deps);
    // Il verdetto ricco costa un indice delle righe di main: su una card già
    // dentro non si chiede, e non lo si paga.
    expect(chiesti).toEqual(["fuori"]);
    expect(s).toEqual({ checked: 2, landed: 1, unlanded: 0, unverifiable: 1, superseded: 0 });
  });

  it("un `unmerged` che la seconda domanda assolve non fa scattare l'allarme", async () => {
    const h = harness({ tasks: [task("a")], status: () => "unmerged", debt: () => "landed" });
    await auditLandings(h.deps);
    expect(h.recorded[0]!.state).toBe("landed");
    expect(h.alerts).toHaveLength(0);
  });

  it("senza la seconda domanda l'audit resta quello di prima: più severo, mai più permissivo", async () => {
    const h = harness({ tasks: [task("a")], status: () => "unmerged" });
    await auditLandings(h.deps);
    expect(h.recorded[0]!.state).toBe("unlanded");
  });

  it("stamps a verdict on every candidate with the same timestamp", async () => {
    const h = harness({ tasks: [task("a"), task("b")], status: () => "merged" });
    const s = await auditLandings(h.deps);
    expect(s).toEqual({ checked: 2, landed: 2, unlanded: 0, unverifiable: 0, superseded: 0 });
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
    expect(s).toEqual({ checked: 1, landed: 0, unlanded: 0, unverifiable: 1, superseded: 0 });
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

  /**
   * L'ACCUSA NON PUÒ SOPRAVVIVERE ALLA SUA PROVA.
   *
   * Senza consegna registrata non c'è niente da verificare, e infatti il test
   * qui sopra dice che si tace. Ma quando sulla card c'è già scritto «non è su
   * main», tacere non è neutrale: è lasciare in piedi un'accusa che nessuno può
   * più sostenere. `markLandPending` scrive quel timbro appena il land viene
   * CHIESTO, e la sua unica via d'uscita è questa passata. Misurate il 18/08
   * sulla board di topics-app: 13 card ferme su «non è su main» senza consegna,
   * la più vecchia da sei giorni, e almeno due con il merge del land su main.
   */
  it("un'accusa senza prova viene RITIRATA, non lasciata in piedi", async () => {
    const h = harness({
      tasks: [task("a", { deliveryCommit: null })],
      previous: { a: "unlanded" },
      status: () => "unmerged",
    });
    const s = await auditLandings(h.deps);
    expect(h.recorded).toEqual([{ id: "a", state: "unverifiable", at: "2026-07-28T10:00:00.000Z" }]);
    expect(s).toEqual({ checked: 1, landed: 0, unlanded: 0, unverifiable: 1, superseded: 0 });
    expect(h.alerts).toHaveLength(0);
  });

  it("ritirando un'accusa non si tocca git: non c'è niente da chiedere", async () => {
    let chiesto = 0;
    const h = harness({
      tasks: [task("a", { deliveryCommit: null })],
      previous: { a: "unlanded" },
      status: () => { chiesto += 1; return "unmerged"; },
      debt: () => { chiesto += 1; return "unlanded"; },
    });
    await auditLandings(h.deps);
    expect(chiesto).toBe(0);
  });

  /**
   * LA TERZA MANIGLIA DUREVOLE. Il land scrive su main un merge che porta il
   * nome della card (`merge task <id>: …`, vedi `task-automerge.ts`), e quel
   * commit resta anche quando il ramo è potato e il commit di consegna non è
   * mai stato registrato. È la stessa prova che un umano guarda a mano, e
   * l'unica che risponde quando le altre due sono sparite.
   */
  it("il merge del land su main prova l'atterraggio quando non resta altro", async () => {
    const h = harness({
      tasks: [task("a", { deliveryCommit: null })],
      previous: { a: "unlanded" },
      landedMerge: () => true,
    });
    const s = await auditLandings(h.deps);
    expect(h.recorded[0]!.state).toBe("landed");
    expect(s.landed).toBe(1);
  });

  it("il merge assolve anche un commit che il repo non ha più", async () => {
    const h = harness({ tasks: [task("a")], status: () => "gone", landedMerge: () => true });
    expect((await auditLandings(h.deps)).landed).toBe(1);
  });

  /**
   * Il merge risponde solo dove le altre prove TACCIONO. Un `unlanded` provato
   * dal commit resta: se dopo il land la card ha prodotto altro lavoro, quel
   * lavoro è ancora fuori, e il merge di ieri non lo copre.
   */
  it("il merge non ribalta un `unlanded` provato dal commit", async () => {
    let chiesto = 0;
    const h = harness({
      tasks: [task("a")],
      status: () => "unmerged",
      landedMerge: () => { chiesto += 1; return true; },
    });
    await auditLandings(h.deps);
    expect(h.recorded[0]!.state).toBe("unlanded");
    expect(chiesto).toBe(0); // e non lo si paga nemmeno
  });

  it("il merge non ribalta un `landed`: non si paga una prova già data", async () => {
    let chiesto = 0;
    const h = harness({
      tasks: [task("a")],
      status: () => "merged",
      landedMerge: () => { chiesto += 1; return true; },
    });
    await auditLandings(h.deps);
    expect(chiesto).toBe(0);
  });

  it("nessun merge trovato: si resta su «non lo so», mai su un'accusa", async () => {
    const h = harness({
      tasks: [task("a", { deliveryCommit: null })],
      previous: { a: "unlanded" },
      landedMerge: () => null,
    });
    const s = await auditLandings(h.deps);
    expect(h.recorded[0]!.state).toBe("unverifiable");
    expect(s.unlanded).toBe(0);
  });

  it("un progetto non risolto non fa cercare nessun merge", async () => {
    let chiesto = 0;
    const h = harness({
      tasks: [task("a", { deliveryCommit: null })],
      previous: { a: "unlanded" },
      repo: () => null,
      landedMerge: () => { chiesto += 1; return true; },
    });
    await auditLandings(h.deps);
    expect(chiesto).toBe(0);
    expect(h.recorded[0]!.state).toBe("unverifiable");
  });

  // REGRESSIONE: il wiring cercava `tasks.project_id` (l'id di BOARD, un hash
  // di percorso) dentro il ProjectStore, che indicizza per UUID. `repoPath`
  // tornava null per OGNI task e l'audit stampava `unverifiable` su tutto,
  // silenziosamente: un contatore che non ha mai verificato niente, esattamente
  // il fallimento che doveva intercettare. Un audit cieco deve dirlo.
  it("un audit che non risolve NIENTE lo dice nel log invece di tacere", async () => {
    const h = harness({ tasks: [task("a"), task("b"), task("c")], repo: () => null });
    const s = await auditLandings(h.deps);
    expect(s).toEqual({ checked: 3, landed: 0, unlanded: 0, unverifiable: 3, superseded: 0 });
    expect(h.logs.some((l) => l.includes("3/3") && l.includes("non verificabili"))).toBe(true);
  });

  it("nessun rumore quando ogni verdetto è certo", async () => {
    const h = harness({ tasks: [task("a"), task("b")], status: () => "merged" });
    await auditLandings(h.deps);
    expect(h.logs).toHaveLength(0);
  });
});
