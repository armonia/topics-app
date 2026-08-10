/**
 * I test del doctor. La forma non e' negoziabile e vale piu' dei singoli casi:
 * per OGNI controllo c'e' un caso che DEVE far scattare il rilievo e uno che
 * NON deve. Il falso allarme e' il difetto piu' probabile di un sorvegliante
 * proattivo — un controllo testato solo sul caso che scatta e' un controllo che
 * non sa dire di no, e un doctor che non sa dire di no viene ignorato in un
 * pomeriggio.
 *
 * Il caso che NON scatta e' costruito, dove si puo', cambiando UN SOLO campo
 * rispetto a quello che scatta: cosi' il test dimostra che il rilievo dipende
 * davvero da quel fatto e non da un dettaglio della fixture.
 *
 *   bun test scripts/board-doctor.test.ts
 */
import { describe, expect, it } from "bun:test";
import {
  CHECKS,
  citesSubtasks,
  costBaselineFromJson,
  DOCTOR,
  EMPTY_STATE,
  filterUnsaid,
  finding,
  groupForRender,
  isProvablyDead,
  isReadOnlyProof,
  parseDbTimestamp,
  pushProbe,
  runChecks,
  touchesVisibleSurface,
  type BranchFacts,
  type CheckId,
  type DoctorInput,
  type DoctorTask,
  type LivenessProbe,
  type RedObservation,
} from "./board-doctor";

// ── Fixture ──────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-08-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3_600_000;

function task(over: Partial<DoctorTask> = {}): DoctorTask {
  return {
    id: "task-1",
    text: "una card qualsiasi",
    status: "review",
    dispatchState: null,
    dispatchAttempts: 0,
    previewImage: null,
    deliveryBranch: null,
    deliveryCommit: null,
    deliveryFiles: null,
    subtaskCount: 0,
    lastAgentComment: null,
    lastHumanCommentAt: null,
    readTotalTokens: 0,
    sizeClass: null,
    ...over,
  };
}

function input(over: Partial<DoctorInput> = {}): DoctorInput {
  return {
    nowMs: NOW,
    dbPath: "/tmp/topics.db",
    repoPath: "/tmp/repo",
    tasks: [],
    branches: [],
    reds: [],
    costBaseline: {},
    probes: {},
    ...over,
  };
}

/** I sondaggi che provano una morte: N concordi, zero figli vivi. */
function deadProbes(n: number = DOCTOR.needsInput.minProbes): LivenessProbe[] {
  return Array.from({ length: n }, (_, i) => ({
    at: ago((n - i) * 10 * 60_000),
    liveChildren: 0,
    progress: "fermo",
  }));
}

const only = (id: CheckId) => new Set<CheckId>([id]);

// ── Il tempo: la trappola delle due ore ──────────────────────────────────────

describe("parseDbTimestamp", () => {
  /**
   * `bun test` gira con il fuso su UTC — misurato: `new Date("2026-08-10
   * 11:01:09")` dentro la suite da' 11:01Z, in una shell a Roma da' 09:01Z. In
   * UTC la lettura ingenua e quella corretta COINCIDONO, quindi un test scritto
   * sull'ora ambientale e' cieco proprio sul difetto che deve vedere (verificato
   * a mano: la mutazione «leggi i timestamp come locali» passava indenne). Il
   * fuso va forzato qui dentro.
   */
  function withTz(tz: string, fn: () => void): void {
    const before = process.env.TZ;
    process.env.TZ = tz;
    try { fn(); } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  }

  it("il formato senza zona vale UTC anche su una macchina che non e' in UTC", () => {
    // `topics.updated_at` e' scritto cosi'.
    withTz("Europe/Rome", () => {
      expect(parseDbTimestamp("2026-08-10 11:01:09")).toBe(Date.parse("2026-08-10T11:01:09Z"));
    });
  });

  it("sono esattamente le due ore che hanno gia' fatto sbagliare due volte", () => {
    withTz("Europe/Rome", () => {
      // Come lo legge `new Date()` a Roma d'estate: stesso testo, istante
      // spostato indietro di due ore. Un task toccato adesso sembrerebbe fermo
      // dalle 09:01, e il doctor lo darebbe per morto.
      const ingenuo = new Date("2026-08-10 11:01:09").getTime();
      const corretto = parseDbTimestamp("2026-08-10 11:01:09");
      if (corretto === null) throw new Error("atteso un timestamp");
      expect(corretto - ingenuo).toBe(2 * H);
    });
  });

  it("le forme con zona sono lette per quello che dicono", () => {
    expect(parseDbTimestamp("2026-08-10T11:01:09.123Z")).toBe(Date.parse("2026-08-10T11:01:09.123Z"));
    expect(parseDbTimestamp("2026-08-10T13:01:09+02:00")).toBe(Date.parse("2026-08-10T11:01:09Z"));
  });

  it("cio' che non si sa leggere torna null (un'ora inventata e' peggio di nessun'ora)", () => {
    for (const bad of ["", "   ", "ieri", "10/08/2026", null, undefined, "2026-08-10T11"]) {
      expect(parseDbTimestamp(bad as string | null)).toBeNull();
    }
  });
});

// ── La prova positiva di morte ───────────────────────────────────────────────

describe("isProvablyDead", () => {
  it("N sondaggi concordi senza figli vivi = fermo", () => {
    const v = isProvablyDead(deadProbes());
    expect(v.dead).toBe(true);
    expect(v.why).toContain("zero figli vivi");
  });

  it("pochi sondaggi non bastano: l'assenza di misure non e' una morte", () => {
    expect(isProvablyDead(deadProbes(DOCTOR.needsInput.minProbes - 1)).dead).toBe(false);
  });

  it("un solo figlio vivo, e non si allarma (il cambio di turno)", () => {
    const p = deadProbes();
    const last = p[p.length - 1];
    if (!last) throw new Error("fixture");
    p[p.length - 1] = { ...last, liveChildren: 1 };
    const v = isProvablyDead(p);
    expect(v.dead).toBe(false);
    expect(v.why).toContain("figlio vivo");
  });

  it("una firma di avanzamento diversa, e non si allarma", () => {
    const p = deadProbes();
    const last = p[p.length - 1];
    if (!last) throw new Error("fixture");
    p[p.length - 1] = { ...last, progress: "si e' mosso" };
    expect(isProvablyDead(p).dead).toBe(false);
  });

  it("guarda solo la coda: una vecchia attivita' non salva un task fermo adesso", () => {
    const p = [{ at: ago(9 * H), liveChildren: 3, progress: "vecchio" }, ...deadProbes()];
    expect(isProvablyDead(p).dead).toBe(true);
  });
});

// ── 1. Consegna che rimanda a un artefatto assente ───────────────────────────

describe("delivery-cites-absent-artifact", () => {
  const cited = task({
    status: "review",
    subtaskCount: 0,
    lastAgentComment: { at: ago(H), content: "Fatto. Il dettaglio sta nei thread dei sottotask." },
  });

  it("SCATTA: la consegna manda ai sottotask e di sottotask non ce n'e' nessuno", () => {
    const f = runChecks(input({ tasks: [cited] }), only("delivery-cites-absent-artifact"));
    expect(f).toHaveLength(1);
    expect(f[0]?.what).toContain("rimanda ai sottotask");
  });

  it("NON scatta: i sottotask citati esistono davvero", () => {
    const f = runChecks(input({ tasks: [task({ ...cited, subtaskCount: 3 })] }), only("delivery-cites-absent-artifact"));
    expect(f).toHaveLength(0);
  });

  it("NON scatta: una consegna che DICHIARA di non avere sottotask e' corretta", () => {
    const denied = task({
      ...cited,
      lastAgentComment: { at: ago(H), content: "Nessun sottotask: era un lavoro a un passo solo." },
    });
    expect(runChecks(input({ tasks: [denied] }), only("delivery-cites-absent-artifact"))).toHaveLength(0);
  });

  it("NON scatta fuori dalla review: una card in corso puo' ancora crearli", () => {
    const wip = task({ ...cited, status: "in_progress" });
    expect(runChecks(input({ tasks: [wip] }), only("delivery-cites-absent-artifact"))).toHaveLength(0);
  });

  it("citesSubtasks distingue il rimando dalla negazione", () => {
    expect(citesSubtasks("vedi i sottotask")).toBe(true);
    expect(citesSubtasks("il dettaglio nei thread dei subtask")).toBe(true);
    expect(citesSubtasks("i sotto-task elencati qui")).toBe(true);
    expect(citesSubtasks("non ci sono sottotask da guardare")).toBe(false);
    expect(citesSubtasks("senza sottotask")).toBe(false);
    // Qui la negazione DEVE vincere: «dei sottotask» e' una citazione a tutti
    // gli effetti, ed e' preceduta da «nessuno». Senza questa riga il guardiano
    // delle negazioni sarebbe codice morto e nessuno se ne accorgerebbe.
    expect(citesSubtasks("non ho creato nessuno dei sottotask elencati")).toBe(false);
    expect(citesSubtasks("zero dei sottotask citati esiste")).toBe(false);
    expect(citesSubtasks("ho spostato la card in review")).toBe(false);
  });
});

// ── 2. Comportamento consegnato senza anteprima ──────────────────────────────

describe("behaviour-without-preview", () => {
  const shipped = task({
    status: "review",
    previewImage: null,
    deliveryCommit: "abc1234",
    deliveryFiles: ["client/src/components/Pane.tsx", "server/routes/tasks.ts"],
  });

  it("SCATTA: consegna che tocca la superficie visibile con anteprima vuota", () => {
    const f = runChecks(input({ tasks: [shipped] }), only("behaviour-without-preview"));
    expect(f).toHaveLength(1);
    expect(f[0]?.action).toContain("video");
  });

  it("NON scatta: l'anteprima c'e'", () => {
    const withPreview = task({ ...shipped, previewImage: "/Users/x/.topics/media/clip.webm" });
    expect(runChecks(input({ tasks: [withPreview] }), only("behaviour-without-preview"))).toHaveLength(0);
  });

  it("NON scatta: lavoro che l'umano non vede (niente da riprendere)", () => {
    const headless = task({ ...shipped, deliveryFiles: ["server/services/tasks.ts", "scripts/board-doctor.ts"] });
    expect(runChecks(input({ tasks: [headless] }), only("behaviour-without-preview"))).toHaveLength(0);
  });

  it("NON scatta: nessun commit di consegna — una domanda non deve un video a nessuno", () => {
    const question = task({ ...shipped, deliveryCommit: null, deliveryFiles: null });
    expect(runChecks(input({ tasks: [question] }), only("behaviour-without-preview"))).toHaveLength(0);
  });

  it("un'anteprima fatta di spazi non e' un'anteprima", () => {
    const blank = task({ ...shipped, previewImage: "   " });
    expect(runChecks(input({ tasks: [blank] }), only("behaviour-without-preview"))).toHaveLength(1);
  });

  it("touchesVisibleSurface guarda il prefisso, non la parola", () => {
    expect(touchesVisibleSurface(["client/src/App.tsx"])).toHaveLength(1);
    expect(touchesVisibleSurface(["server/client-helpers.ts", "docs/client/notes.md"])).toHaveLength(0);
  });
});

// ── 3. Land che trascina commit non della card ───────────────────────────────

describe("land-drags-foreign-commits", () => {
  const t = task({ id: "t-land", deliveryBranch: "topics/tangy" });
  const facts: BranchFacts = {
    taskId: "t-land",
    branch: "topics/tangy",
    defaultBranch: "main",
    headSha: "deadbee",
    aheadTotal: 13,
    ownCount: 7,
    foreignHead: "cafe123",
    otherBranches: ["topics/gruppi-spazi-pulizia"],
  };

  it("SCATTA: 13 commit ma solo 7 della card (il guasto del 2026-08-09)", () => {
    const f = runChecks(input({ tasks: [t], branches: [facts] }), only("land-drags-foreign-commits"));
    expect(f).toHaveLength(1);
    expect(f[0]?.what).toContain("altri 6");
  });

  it("NON scatta: il branch porta solo lavoro suo", () => {
    const clean = { ...facts, ownCount: 13 };
    expect(runChecks(input({ tasks: [t], branches: [clean] }), only("land-drags-foreign-commits"))).toHaveLength(0);
  });

  it("NON scatta su una card ancora in corso: il branch si muove e il land non e' sul tavolo", () => {
    const wip = task({ ...t, status: "in_progress" });
    expect(runChecks(input({ tasks: [wip], branches: [facts] }), only("land-drags-foreign-commits"))).toHaveLength(0);
  });

  it("NON scatta: branch allineato a main, zero commit da portare", () => {
    const empty = { ...facts, aheadTotal: 0, ownCount: 0 };
    expect(runChecks(input({ tasks: [t], branches: [empty] }), only("land-drags-foreign-commits"))).toHaveLength(0);
  });

  it("un branch il cui nome contiene un verbo che scrive non fa esplodere la prova", () => {
    // `fix/reset-attempts` finisce dentro il comando di prova: un controllo di
    // sola-lettura fatto per parole isolate lo boccerebbe, e il doctor
    // morirebbe su una card innocua.
    const noisy = { ...facts, branch: "fix/reset-attempts", otherBranches: ["chore/merge-queue"] };
    const t2 = task({ ...t, deliveryBranch: noisy.branch });
    const f = runChecks(input({ tasks: [t2], branches: [noisy] }), only("land-drags-foreign-commits"));
    expect(f).toHaveLength(1);
    expect(isReadOnlyProof(f[0]?.proof ?? "")).toBe(true);
  });
});

// ── 4. needs_input fermo senza risposta ──────────────────────────────────────

describe("needs-input-unanswered", () => {
  const stuck = task({
    id: "t-stuck",
    status: "review",
    dispatchState: "needs_input",
    dispatchAttempts: 2,
    lastAgentComment: { at: ago(3 * H), content: "Confermi X?" },
    lastHumanCommentAt: null,
  });
  const probes = { "t-stuck": deadProbes() };

  it("SCATTA: due tentativi, tre ore di silenzio, morte provata", () => {
    const f = runChecks(input({ tasks: [stuck], probes }), only("needs-input-unanswered"));
    expect(f).toHaveLength(1);
    expect(f[0]?.what).toContain("needs_input");
  });

  it("NON scatta: l'umano ha risposto dopo la domanda", () => {
    const answered = task({ ...stuck, lastHumanCommentAt: ago(H) });
    expect(runChecks(input({ tasks: [answered], probes }), only("needs-input-unanswered"))).toHaveLength(0);
  });

  it("NON scatta: la domanda e' recente (un turno umano non e' un guasto)", () => {
    const fresh = task({ ...stuck, lastAgentComment: { at: ago(5 * 60_000), content: "Confermi X?" } });
    expect(runChecks(input({ tasks: [fresh], probes }), only("needs-input-unanswered"))).toHaveLength(0);
  });

  it("NON scatta al primo tentativo", () => {
    const first = task({ ...stuck, dispatchAttempts: 1 });
    expect(runChecks(input({ tasks: [first], probes }), only("needs-input-unanswered"))).toHaveLength(0);
  });

  it("NON scatta senza prova di morte: fermo agli occhi, ma un figlio e' vivo", () => {
    const alive = deadProbes();
    const last = alive[alive.length - 1];
    if (!last) throw new Error("fixture");
    alive[alive.length - 1] = { ...last, liveChildren: 1 };
    expect(runChecks(input({ tasks: [stuck], probes: { "t-stuck": alive } }), only("needs-input-unanswered"))).toHaveLength(0);
  });

  it("NON scatta al primo giro: i sondaggi non ci sono ancora", () => {
    expect(runChecks(input({ tasks: [stuck], probes: {} }), only("needs-input-unanswered"))).toHaveLength(0);
  });

  it("una risposta umana scritta nel formato senza zona conta lo stesso", () => {
    // Se il confronto leggesse questa data come locale, la risposta sembrerebbe
    // arrivata PRIMA della domanda e la card verrebbe segnalata lo stesso.
    const askedAt = new Date(NOW - 3 * H).toISOString();
    const repliedNaive = new Date(NOW - 2 * H).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
    const t = task({ ...stuck, lastAgentComment: { at: askedAt, content: "Confermi X?" }, lastHumanCommentAt: repliedNaive });
    expect(runChecks(input({ tasks: [t], probes }), only("needs-input-unanswered"))).toHaveLength(0);
  });
});

// ── 5. Rosso ambientale ──────────────────────────────────────────────────────

describe("environmental-red", () => {
  const t = task({ id: "t-red" });
  const red: RedObservation = {
    taskId: "t-red",
    command: "bun run test:unit",
    worktreePath: "/wt",
    worktreeExit: 1,
    mainPath: "/main",
    mainExit: 0,
  };

  it("SCATTA: rosso nel worktree, verde nel checkout principale", () => {
    const f = runChecks(input({ tasks: [t], reds: [red] }), only("environmental-red"));
    expect(f).toHaveLength(1);
    expect(f[0]?.action).toContain("non rigettare");
  });

  it("NON scatta: rosso in tutti e due — quella e' una regressione vera", () => {
    expect(runChecks(input({ tasks: [t], reds: [{ ...red, mainExit: 1 }] }), only("environmental-red"))).toHaveLength(0);
  });

  it("NON scatta: verde nel worktree, non c'e' niente da spiegare", () => {
    expect(runChecks(input({ tasks: [t], reds: [{ ...red, worktreeExit: 0 }] }), only("environmental-red"))).toHaveLength(0);
  });

  it("NON scatta senza il secondo giro: mezza misura non e' una prova", () => {
    expect(runChecks(input({ tasks: [t], reds: [{ ...red, mainExit: null }] }), only("environmental-red"))).toHaveLength(0);
  });
});

// ── 6. Costo fuori scala ─────────────────────────────────────────────────────

describe("cost-out-of-class", () => {
  const base = { costBaseline: { small: { median: 1_766_926, n: 27 } } };
  const pricey = task({ id: "t-cost", sizeClass: "small", readTotalTokens: 8_000_000 });

  it("SCATTA: 4,5× la mediana della sua classe", () => {
    const f = runChecks(input({ tasks: [pricey], ...base }), only("cost-out-of-class"));
    expect(f).toHaveLength(1);
    expect(f[0]?.what).toContain("4.5×");
  });

  it("NON scatta appena sotto la soglia dichiarata", () => {
    const ok = task({ ...pricey, readTotalTokens: 1_766_926 * DOCTOR.cost.factor - 1 });
    expect(runChecks(input({ tasks: [ok], ...base }), only("cost-out-of-class"))).toHaveLength(0);
  });

  it("NON scatta se la classe non ha abbastanza osservazioni: senza metro, nessun allarme", () => {
    const thin = { costBaseline: { small: { median: 1_766_926, n: DOCTOR.cost.minClassN - 1 } } };
    expect(runChecks(input({ tasks: [pricey], ...thin }), only("cost-out-of-class"))).toHaveLength(0);
  });

  it("NON scatta senza baseline (il controllo resta inerte, non ottimista)", () => {
    expect(runChecks(input({ tasks: [pricey] }), only("cost-out-of-class"))).toHaveLength(0);
  });

  it("NON scatta su una card senza classe", () => {
    const unclassified = task({ ...pricey, sizeClass: null });
    expect(runChecks(input({ tasks: [unclassified], ...base }), only("cost-out-of-class"))).toHaveLength(0);
  });

  it("costBaselineFromJson legge il JSON di board-baseline e ignora il resto", () => {
    const b = costBaselineFromJson({
      board: { byClass: { primary: { classes: { small: { n: 27, readTotalTokens: { median: 42 } }, medium: { n: 5 } } } } },
    });
    expect(b.small).toEqual({ median: 42, n: 27 });
    expect(b.medium).toBeUndefined();
    expect(costBaselineFromJson({})).toEqual({});
  });
});

// ── La disciplina, verificata su tutti i controlli insieme ───────────────────

/** Una fixture per ogni controllo, quella che DEVE far scattare il rilievo. */
function everythingWrong(): DoctorInput {
  return input({
    tasks: [
      task({ id: "a", status: "review", subtaskCount: 0, lastAgentComment: { at: ago(H), content: "vedi i sottotask" } }),
      task({ id: "b", status: "review", deliveryCommit: "abc1234", deliveryFiles: ["client/src/App.tsx"] }),
      task({ id: "c", deliveryBranch: "topics/x" }),
      task({
        id: "d", status: "review", dispatchState: "needs_input", dispatchAttempts: 2,
        lastAgentComment: { at: ago(3 * H), content: "Confermi?" },
      }),
      task({ id: "e" }),
      task({ id: "f", sizeClass: "medium", readTotalTokens: 90_000_000 }),
    ],
    branches: [{ taskId: "c", branch: "topics/x", defaultBranch: "main", headSha: "abc", aheadTotal: 5, ownCount: 1, foreignHead: "f00d", otherBranches: ["topics/y"] }],
    reds: [{ taskId: "e", command: "bun run test:unit", worktreePath: "/wt", worktreeExit: 1, mainPath: "/main", mainExit: 0 }],
    costBaseline: { medium: { median: 5_649_737, n: 56 } },
    probes: { d: deadProbes() },
  });
}

describe("disciplina", () => {
  it("una board sana produce SILENZIO, non un rapporto di controlli passati", () => {
    expect(runChecks(input({ tasks: [task(), task({ id: "t2", status: "in_progress" })] }))).toEqual([]);
  });

  it("ogni controllo dichiarato sa scattare almeno una volta (nessun controllo morto)", () => {
    const seen = new Set(runChecks(everythingWrong()).map((f) => f.check));
    expect([...seen].sort()).toEqual([...CHECKS.map((c) => c.id)].sort());
  });

  it("ogni rilievo porta la prova e l'azione, e la prova non scrive niente", () => {
    for (const f of runChecks(everythingWrong())) {
      expect(f.proof.trim().length).toBeGreaterThan(0);
      expect(f.action.trim().length).toBeGreaterThan(0);
      expect(f.occurrence.startsWith(f.check)).toBe(true);
      expect(isReadOnlyProof(f.proof)).toBe(true);
    }
  });

  it("ogni controllo dichiara il guasto vero da cui nasce", () => {
    for (const c of CHECKS) expect(c.bornFrom.length).toBeGreaterThan(20);
  });

  it("un rilievo senza prova o senza azione non e' costruibile", () => {
    const ok = { check: "needs-input-unanswered" as CheckId, taskId: "x", taskText: "t", what: "w", proof: "git log", action: "a", occurrence: "o" };
    expect(() => finding(ok)).not.toThrow();
    expect(() => finding({ ...ok, proof: "" })).toThrow(/manca proof/);
    expect(() => finding({ ...ok, action: "  " })).toThrow(/manca action/);
    expect(() => finding({ ...ok, occurrence: "" })).toThrow(/manca occurrence/);
    expect(() => finding({ ...ok, proof: "git merge topics/x" })).toThrow(/sola lettura/);
  });

  it("lo stesso fatto produce la stessa occorrenza, un fatto diverso una nuova", () => {
    const keys = (i: DoctorInput) => runChecks(i).map((f) => f.occurrence).sort();
    expect(keys(everythingWrong())).toEqual(keys(everythingWrong()));

    // Il branch si muove: e' un fatto nuovo e il doctor deve poterlo ridire.
    const moved = everythingWrong();
    const b = moved.branches[0];
    if (!b) throw new Error("fixture");
    const after = input({ ...moved, branches: [{ ...b, headSha: "999zzz" }] });
    const before = new Set(keys(moved));
    expect(keys(after).some((k) => !before.has(k))).toBe(true);
  });

  it("cio' che e' gia' stato detto viene taciuto", () => {
    const all = runChecks(everythingWrong());
    const said = Object.fromEntries(all.slice(0, 2).map((f) => [f.occurrence, ago(H)]));
    const { fresh, suppressed } = filterUnsaid(all, said);
    expect(suppressed).toHaveLength(2);
    expect(fresh).toHaveLength(all.length - 2);
    // Secondo giro con tutto in registro: silenzio totale.
    expect(filterUnsaid(all, Object.fromEntries(all.map((f) => [f.occurrence, ago(H)]))).fresh).toHaveLength(0);
  });

  it("card colpite dalla stessa causa si leggono in un blocco solo", () => {
    // Il 2026-08-10 erano dieci: dieci righe per una decisione sola. Il
    // registro resta per card — sono dieci fatti — ma la STAMPA ne fa una.
    const facts = (id: string, foreignHead: string): BranchFacts => ({
      taskId: id, branch: `topics/${id}`, defaultBranch: "main", headSha: `h-${id}`,
      aheadTotal: 9, ownCount: 1, foreignHead, otherBranches: ["topics/altro"],
    });
    const same = runChecks(input({
      tasks: [task({ id: "a" }), task({ id: "b" }), task({ id: "c" })],
      branches: [facts("a", "cafe1"), facts("b", "cafe1"), facts("c", "beef2")],
    }), only("land-drags-foreign-commits"));

    expect(same).toHaveLength(3); // tre fatti, tre occorrenze nel registro
    const blocks = groupForRender(same);
    expect(blocks.map((b) => b.length)).toEqual([2, 1]); // due blocchi da leggere
    expect(new Set(same.map((f) => f.occurrence)).size).toBe(3);
  });

  it("senza causa condivisa non si raggruppa niente", () => {
    const solo = runChecks(everythingWrong());
    const grouped = groupForRender(solo);
    expect(grouped).toHaveLength(solo.length);
  });

  it("il registro parte vuoto e non inventa niente", () => {
    expect(EMPTY_STATE.said).toEqual({});
    expect(filterUnsaid(runChecks(everythingWrong()), EMPTY_STATE.said).suppressed).toHaveLength(0);
  });

  it("i sondaggi si accumulano ma la coda resta corta", () => {
    let p: LivenessProbe[] = [];
    for (let i = 0; i < 10; i++) p = pushProbe(p, { at: ago(i * 60_000), liveChildren: 0, progress: `p${i}` });
    expect(p).toHaveLength(DOCTOR.needsInput.minProbes);
    expect(p[p.length - 1]?.progress).toBe("p9");
  });
});

describe("isReadOnlyProof", () => {
  it("accetta le letture, anche quelle che NOMINANO un verbo che scrive", () => {
    for (const good of [
      "git -C /repo rev-list --count main..topics/x --not fix/reset-attempts",
      "git -C /repo show --stat --format= abc1234",
      `sqlite3 '/d/topics.db' "SELECT COUNT(*) FROM tasks WHERE created_at >= '2026-08-01'"`,
      "bun scripts/board-baseline.ts --json | jq '.board'",
      `(cd /wt && bun run test:unit); echo "worktree=$?"`,
      // Percorso con uno spazio dentro gli apici, e una sostituzione di comando:
      // se il verbo di git non si trovasse, questa prova onesta verrebbe
      // bocciata e il doctor morirebbe nel costruirla.
      "git -C '/Volumi/disco 2/repo' log --oneline main..topics/x --not $(git -C '/Volumi/disco 2/repo' for-each-ref --format='%(refname:short)' refs/heads/ | grep -vx -e topics/x -e main)",
    ]) expect(isReadOnlyProof(good)).toBe(true);
  });

  it("rifiuta tutto cio' che tocca l'albero o il DB", () => {
    for (const bad of [
      "git merge topics/x",
      "git -C /repo push origin main",
      "git checkout main",
      "rm -rf /tmp/x",
      `sqlite3 /d/topics.db "UPDATE tasks SET status='done'"`,
      "git log --oneline > /tmp/out.txt",
    ]) expect(isReadOnlyProof(bad)).toBe(false);
  });
});
