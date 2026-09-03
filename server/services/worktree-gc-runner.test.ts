/**
 * Il CABLAGGIO della potatura, non la sua decisione.
 *
 * Le decisioni (chi si pota, chi si tiene, con che contratto di sicurezza) sono
 * gia' provate in `worktree-gc.test.ts`, su `sweepWorktrees`. Qui si prova la
 * cosa che l'estrazione da `server.ts` poteva rompere e che nessun altro test
 * guarda: che la fabbrica costruisca, che le dipendenze arrivino, e che il giro
 * completo si esegua senza toccare niente quando non c'e' niente da toccare.
 *
 * PERCHE' ESISTE. Il blocco viveva in fondo a `server.ts` come `function`
 * dichiarata, e i tre punti che lo usano stanno piu' in alto: si reggeva
 * sull'hoisting. Passando a una fabbrica, un errore di ORDINE non si vede al
 * typecheck — si vede a runtime, la prima volta che il timer scatta, cioe' due
 * minuti dopo il boot in produzione. Questo test e' il posto in cui si vede
 * subito.
 *
 * @covers WORKTREE-09
 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeGcRunner, type WorktreeGcDeps } from "./worktree-gc-runner";
import { gitEnv } from "../../tests/setup/bun-test-preload";

/** Dipendenze inerti: rispondono, non fanno nulla, e registrano se le chiamano. */
function fakeDeps(over: Partial<WorktreeGcDeps> = {}): { deps: WorktreeGcDeps; toccati: string[]; annunci: unknown[]; db: Database } {
  const toccati: string[] = [];
  const annunci: unknown[] = [];
  const db = new Database(":memory:");
  db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, archived INTEGER, updated_at TEXT, assigned_topic_id TEXT)");
  db.run("CREATE TABLE task_comments (id TEXT PRIMARY KEY, task_id TEXT, created_at TEXT)");
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT, worktree_id TEXT)");
  db.run("CREATE TABLE messages (session_key TEXT, timestamp TEXT)");
  const deps: WorktreeGcDeps = {
    db,
    broadcast: (msg) => { annunci.push(msg); },
    worktreeStore: { list: () => [] },
    worktreeManager: { delete: async (id) => { toccati.push(`delete:${id}`); return null; } },
    projectStore: { get: () => ({ path: "/tmp/non-esiste" }) },
    getTopicBySessionKey: () => null,
    resolveTopicCwd: () => null,
    svc: {
      get: () => null,
      release: () => { toccati.push("release"); },
      addComment: () => { toccati.push("addComment"); },
      recordDelivery: () => { toccati.push("recordDelivery"); },
      getBoardSettings: () => ({ dispatchAutoMerge: false }),
    },
    isInFlight: () => false,
    worktreeOfTask: () => null,
    projectIdForPath: () => null,
    deliveryIsOnMain: async () => null,
    tryMerge: async () => { toccati.push("tryMerge"); return { status: "nothing" }; },
    previewList: () => [],
    previewTeardown: async () => { toccati.push("previewTeardown"); },
    ...over,
  };
  return { deps, toccati, annunci, db };
}

/**
 * La coppia topic+task che la potatura risolve a partire da un worktree.
 * `projectId` NON compare qui: sulla card lo scrive il servizio task, e i test
 * che lo guardano se lo fanno restituire dal doppio di `svc.get`.
 */
function bindTask(db: Database, opts: { taskId: string; worktreeId: string; status: string }): void {
  const topicId = `topic-${opts.taskId}`;
  db.run("INSERT INTO topics (id, session_key, worktree_id) VALUES (?, ?, ?)", [topicId, `topic:${opts.taskId}`, opts.worktreeId]);
  db.run(
    "INSERT INTO tasks (id, status, archived, updated_at, assigned_topic_id) VALUES (?, ?, 0, ?, ?)",
    [opts.taskId, opts.status, new Date().toISOString(), topicId],
  );
}

describe("il cablaggio della potatura dei worktree", () => {
  it("la fabbrica costruisce e pubblica i due tempi dell'avvio", () => {
    const { deps } = fakeDeps();
    const gc = createWorktreeGcRunner(deps);
    expect(typeof gc.runWorktreeGc).toBe("function");
    expect(typeof gc.slimWorktreeOfTask).toBe("function");
    // I due numeri erano letterali dentro `setTimeout`/`setInterval` in
    // `server.ts`: adesso li dichiara il modulo, e restano gli stessi.
    expect(gc.intervalMs).toBe(30 * 60_000);
    expect(gc.bootDelayMs).toBe(120_000);
  });

  it("un giro a vuoto non tocca NIENTE, e lo dice", async () => {
    // E' il caso che conta: senza worktree da valutare, un sottosistema che
    // distrugge deve restare fermo. Se qui comparisse un `delete`, sarebbe la
    // prova che il giro fa qualcosa per conto suo.
    const { deps, toccati } = fakeDeps();
    const gc = createWorktreeGcRunner(deps);
    const esito = await gc.runWorktreeGc();
    expect(esito).not.toBeNull();
    expect(esito!.total).toBe(0);
    expect(esito!.reaped).toBe(0);
    expect(toccati).toEqual([]);
  });

  it("un errore dentro il giro non propaga: la potatura non puo' abbattere il server", async () => {
    // Il `catch` finale c'era in `server.ts` e va con il codice, non col
    // chiamante: un timer che esplode ogni trenta minuti si nota tardi.
    const { deps } = fakeDeps({
      worktreeStore: { list: () => { throw new Error("store rotto"); } },
    });
    const gc = createWorktreeGcRunner(deps);
    expect(await gc.runWorktreeGc()).toBeNull();
  });

  it("lo sfoltimento di un task senza worktree e' un non-evento", async () => {
    const { deps, toccati } = fakeDeps();
    const gc = createWorktreeGcRunner(deps);
    await gc.slimWorktreeOfTask("t-inesistente");
    expect(toccati).toEqual([]);
  });

  it("un turno IN VOLO ferma lo sfoltimento prima di guardare il disco", async () => {
    // La guardia piu' importante di `slimWorktreeOfTask`: togliere
    // `node_modules` sotto i piedi di un agente che sta lavorando.
    const letture: string[] = [];
    const { deps } = fakeDeps({
      isInFlight: () => true,
      worktreeOfTask: (taskId) => { letture.push(taskId); return { id: "w1", absPath: "/tmp/x", projectId: "p" }; },
    });
    const gc = createWorktreeGcRunner(deps);
    await gc.slimWorktreeOfTask("t1");
    expect(letture).toEqual(["t1"]);   // ha risolto il worktree…
    // …e si e' fermato: nessuna chiamata al disco oltre l'esistenza.
  });
});

/**
 * LA POTATURA PARLA A UN TIMER, NON A UNA ROTTA.
 *
 * Ogni scrittura che fa su una card — il park `failed`, la riga nel thread, il
 * ramo di consegna timbrato — nasce dentro un `setInterval`, e dietro non c'e'
 * nessuna richiesta HTTP che ne trasmetta l'esito. Fino al 19/08/2026 la
 * fabbrica non aveva nemmeno un modo per farlo: `broadcast` non era fra le sue
 * dipendenze. Il risultato non era un errore, era il silenzio — la card
 * cambiava nel database e restava com'era su ogni schermo aperto, e la board
 * mostrava «in lavorazione» su un task parcheggiato alle tre di notte.
 *
 * Questi test guardano l'unica cosa che il typecheck non puo' guardare: che il
 * frame parta davvero da ognuno dei percorsi che scrivono.
 */
describe("la potatura ANNUNCIA cio' che scrive sulle card", () => {
  /** Il doppio del servizio task: una card sola, con l'id di BOARD sopra. */
  function svcConCard(taskId: string, toccati: string[], patch: Record<string, unknown> = {}) {
    const task = { id: taskId, projectId: "board-hash-1", text: "una card", deliveryCommit: null, deliveryBranch: null, ...patch };
    return {
      get: (id: string) => (id === taskId ? { task } : null),
      release: () => { toccati.push("release"); },
      addComment: () => { toccati.push("addComment"); },
      setDeliveryBranch: () => { toccati.push("setDeliveryBranch"); },
      recordDelivery: () => { toccati.push("recordDelivery"); },
      getBoardSettings: () => ({ dispatchAutoMerge: false }),
    };
  }

  /** Un worktree in modo `branch` il cui ramo non risolve piu': la riga fantasma. */
  function fantasma(worktreeId: string) {
    return {
      list: () => [{ id: worktreeId, projectId: "store-uuid-1", absPath: "/tmp/questa-cartella-non-esiste", branchName: "topics/fantasma", mode: "branch" }],
    };
  }

  it("un task parcheggiato `failed` esce sul filo, non solo nel database", async () => {
    // Il percorso `abandon`: ramo sparito sotto un task che dichiara di
    // starci lavorando. `release` lo declassa, e senza annuncio la board
    // continuerebbe a mostrarlo in lavorazione fino al ricaricamento.
    const toccati: string[] = [];
    const { deps, annunci, db } = fakeDeps({
      worktreeStore: fantasma("w-abbandonato"),
      projectStore: { get: () => null },          // niente repo ⇒ ramo "gone"
      worktreeManager: { delete: async () => true },
      svc: svcConCard("t-abbandonato", toccati),
    });
    bindTask(db, { taskId: "t-abbandonato", worktreeId: "w-abbandonato", status: "in_progress" });

    const esito = await createWorktreeGcRunner(deps).runWorktreeGc();

    expect(esito!.abandoned).toBe(1);
    expect(toccati).toContain("release");
    expect(annunci).toEqual([
      { type: "task:updated", projectId: "board-hash-1", task: expect.objectContaining({ id: "t-abbandonato" }) },
    ]);
  });

  it("lo scioglimento di una card in review esce sul filo allo stesso modo", async () => {
    // `unbind` NON declassa: la card resta in review. Cambia comunque, perche'
    // perde il legame col worktree, ed e' quel legame a decidere se il bottone
    // che apre la cartella ha ancora un posto dove andare.
    const toccati: string[] = [];
    const { deps, annunci, db } = fakeDeps({
      worktreeStore: fantasma("w-slegato"),
      projectStore: { get: () => null },
      worktreeManager: { delete: async () => true },
      svc: svcConCard("t-slegato", toccati),
    });
    bindTask(db, { taskId: "t-slegato", worktreeId: "w-slegato", status: "review" });

    const esito = await createWorktreeGcRunner(deps).runWorktreeGc();

    expect(esito!.unbound).toBe(1);
    expect(toccati).toContain("release");
    expect(annunci).toHaveLength(1);
    expect(annunci[0]).toMatchObject({ type: "task:updated", projectId: "board-hash-1" });
  });

  it("il `projectId` annunciato e' quello della CARD, mai quello del worktree", async () => {
    // I due id vivono in namespace diversi: `wt.projectId` e' l'uuid del
    // projectStore, la board filtra per l'id scritto sulla card. Passare il
    // primo non solleva niente e non si vede da nessuna parte: il client
    // riceve il frame e lo butta, che e' il silenzio da cui siamo partiti.
    const toccati: string[] = [];
    const { deps, annunci, db } = fakeDeps({
      worktreeStore: fantasma("w-namespace"),
      projectStore: { get: () => null },
      worktreeManager: { delete: async () => true },
      svc: svcConCard("t-namespace", toccati),
    });
    bindTask(db, { taskId: "t-namespace", worktreeId: "w-namespace", status: "in_progress" });

    await createWorktreeGcRunner(deps).runWorktreeGc();

    const frame = annunci[0] as { projectId: string };
    expect(frame.projectId).toBe("board-hash-1");
    expect(frame.projectId).not.toBe("store-uuid-1");
  });

  it("anche la riga scritta nel thread viene annunciata", async () => {
    // Il worktree tenuto per modifiche non committate: la potatura non
    // distrugge niente, ma SCRIVE — ed e' proprio quella riga che dice
    // all'umano dove sta il suo lavoro. Arrivare solo al prossimo
    // ricaricamento vuol dire arrivare dopo che l'ha gia' cercato.
    const dir = mkdtempSync(join(tmpdir(), "gc-runner-sporco-"));
    try {
      const toccati: string[] = [];
      const { deps, annunci, db } = fakeDeps({
        // `reuse`: il ramo non e' suo, quindi la riga fantasma non entra in
        // gioco e si arriva alla sonda dello sporco. La cartella esiste ma non
        // e' un repo git: `git status` esce non-zero, e chi non ha potuto
        // guardare non ha il diritto di distruggere.
        worktreeStore: { list: () => [{ id: "w-sporco", projectId: "store-uuid-1", absPath: dir, branchName: null, mode: "reuse" }] },
        worktreeManager: { delete: async () => true },
        svc: svcConCard("t-sporco", toccati),
      });
      bindTask(db, { taskId: "t-sporco", worktreeId: "w-sporco", status: "done" });

      const esito = await createWorktreeGcRunner(deps).runWorktreeGc();

      expect(esito!.kept).toBe(1);
      expect(toccati).toContain("addComment");
      expect(annunci).toHaveLength(1);
      expect(annunci[0]).toMatchObject({ type: "task:updated", projectId: "board-hash-1" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("un filo rotto non ferma la potatura: l'annuncio e' best-effort", async () => {
    // La regola di tutto questo file: nessun effetto di contorno puo' abbattere
    // un giro che serve a liberare spazio. Se il broadcast alza, il task e'
    // gia' parcheggiato e la cartella va rimossa lo stesso.
    const toccati: string[] = [];
    const { deps, db } = fakeDeps({
      worktreeStore: fantasma("w-filo-rotto"),
      projectStore: { get: () => null },
      worktreeManager: { delete: async () => true },
      svc: svcConCard("t-filo-rotto", toccati),
      broadcast: () => { throw new Error("client staccati"); },
    });
    bindTask(db, { taskId: "t-filo-rotto", worktreeId: "w-filo-rotto", status: "in_progress" });

    const esito = await createWorktreeGcRunner(deps).runWorktreeGc();

    expect(esito).not.toBeNull();
    expect(esito!.abandoned).toBe(1);
    expect(toccati).toContain("release");
  });
});

/**
 * UNA PASSATA ALLA VOLTA.
 *
 * Quattro punti lanciano la potatura (boot, timer, rotta `/__daemon`, `runGc`).
 * Finché leggeva soltanto, due giri sovrapposti erano lavoro doppio e basta.
 * Da quando SCRIVE — il residuo committato sul ramo — due `git add` nella
 * stessa cartella si contendono `index.lock`, e chi perde non riprova.
 * Misurato il 19/08/2026 al primo giro col codice nuovo: sette worktree persi
 * per «Unable to create index.lock: File exists».
 */
describe("rientro della potatura", () => {
  it("due chiamate sovrapposte condividono LA STESSA passata", async () => {
    let giri = 0;
    const { deps } = fakeDeps({ worktreeStore: { list: () => { giri += 1; return []; } } });
    const gc = createWorktreeGcRunner(deps);

    const a = gc.runWorktreeGc();
    const b = gc.runWorktreeGc();

    // Non «due passate che finiscono uguale»: proprio lo stesso oggetto, così
    // chi arriva secondo legge l'esito vero invece di un `null` da interpretare.
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(giri).toBe(1);
  });

  it("finita la passata, la successiva riparte davvero (non è un interruttore a senso unico)", async () => {
    let giri = 0;
    const { deps } = fakeDeps({ worktreeStore: { list: () => { giri += 1; return []; } } });
    const gc = createWorktreeGcRunner(deps);

    await gc.runWorktreeGc();
    await gc.runWorktreeGc();

    expect(giri).toBe(2);
  });
});

/**
 * `pending` ROWS ENTER THE SWEEP.
 *
 * The only writer of `pending -> ready|error` is the in-memory closure of
 * `create()`: a restart mid-materialise (or an update the DB swallowed) left
 * the row `pending` forever, and the sweep (`list({ status: "ready" })`)
 * skipped it every round. The UI showed the loader, the folder (up to ~200 MB)
 * and the branch stayed. Three weeks of evidence on two projects, 2026-09-03.
 *
 * The three lines not to get wrong: a `pending` row in THIS process's hands is
 * never touched, however old (the per-project queue can hold it behind other
 * installs); a fresh one neither; a stale one with folder and branch is
 * repaired (back to `ready`, with the frame for the UI) and the same sweep
 * judges it.
 */
describe("le righe pending stantie", () => {
  const OLD = new Date(Date.now() - 60 * 60_000).toISOString();

  function realRepo(): { root: string; repo: string; absPath: string } {
    const root = mkdtempSync(join(tmpdir(), "gc-pending-"));
    const repo = join(root, "repo");
    const run = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() }).exitCode;
    expect(run(root, "init", "--quiet", "repo")).toBe(0);
    run(repo, "config", "user.email", "t@t.t");
    run(repo, "config", "user.name", "t");
    run(repo, "symbolic-ref", "HEAD", "refs/heads/main");
    writeFileSync(join(repo, "README.md"), "base\n");
    run(repo, "add", "-A");
    expect(run(repo, "commit", "-q", "-m", "base")).toBe(0);
    const absPath = join(root, "wt");
    expect(run(repo, "worktree", "add", "-q", "-b", "topics/wt", absPath, "main")).toBe(0);
    return { root, repo, absPath };
  }

  function pendingRow(absPath: string, createdAt: string) {
    return { id: "w-pend", projectId: "p", absPath, branchName: "topics/wt", mode: "branch", status: "pending", createdAt };
  }

  it("stantia, con cartella e ramo: torna `ready`, la UI lo sente, e la passata la giudica", async () => {
    const { root, repo, absPath } = realRepo();
    const updates: Array<{ id: string; patch: unknown }> = [];
    try {
      const row = pendingRow(absPath, OLD);
      const { deps, toccati, annunci } = fakeDeps({
        worktreeStore: { list: () => [row], update: (id, patch) => { updates.push({ id, patch }); return { ...row, ...patch }; } },
        projectStore: { get: () => ({ path: repo }) },
      });
      const gc = createWorktreeGcRunner(deps);
      const esito = await gc.runWorktreeGc();

      expect(updates).toEqual([{ id: "w-pend", patch: { status: "ready" } }]);
      const frames = annunci as Array<{ type?: string; worktree?: { status?: string } }>;
      expect(frames.some((m) => m?.type === "worktree:updated" && m.worktree?.status === "ready")).toBe(true);
      // Orphan, clean, branch level with main: the SAME sweep collects it.
      expect(esito!.total).toBe(1);
      expect(toccati).toContain("delete:w-pend");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("in mano a questo processo: non si tocca, per quanto vecchia", async () => {
    const updates: unknown[] = [];
    const deletedIds: string[] = [];
    const { deps } = fakeDeps({
      worktreeStore: { list: () => [pendingRow("/tmp/non-esiste", OLD)], update: (id, patch) => { updates.push({ id, patch }); return null; } },
      worktreeManager: { delete: async (id) => { deletedIds.push(id); return null; }, isMaterialising: () => true },
    });
    const gc = createWorktreeGcRunner(deps);
    const esito = await gc.runWorktreeGc();
    expect(esito!.total).toBe(0);
    expect(updates).toEqual([]);
    expect(deletedIds).toEqual([]);
  });

  it("fresca: la grazia la copre anche senza `isMaterialising`", async () => {
    const { deps, toccati } = fakeDeps({
      worktreeStore: { list: () => [pendingRow("/tmp/non-esiste", new Date().toISOString())] },
    });
    const gc = createWorktreeGcRunner(deps);
    const esito = await gc.runWorktreeGc();
    expect(esito!.total).toBe(0);
    expect(toccati).toEqual([]);
  });

  it("stantia, senza cartella ne' ramo: non si ripara, ma la passata la raccoglie come riga fantasma", async () => {
    const updates: unknown[] = [];
    const { deps, toccati } = fakeDeps({
      worktreeStore: { list: () => [pendingRow("/tmp/non-esiste", OLD)], update: (id, patch) => { updates.push({ id, patch }); return null; } },
      projectStore: { get: () => ({ path: "/tmp/non-esiste-repo" }) },
    });
    const gc = createWorktreeGcRunner(deps);
    const esito = await gc.runWorktreeGc();
    expect(updates).toEqual([]);
    expect(esito!.total).toBe(1);
    expect(toccati).toContain("delete:w-pend");
  });
});
