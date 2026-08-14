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
 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createWorktreeGcRunner, type WorktreeGcDeps } from "./worktree-gc-runner";

/** Dipendenze inerti: rispondono, non fanno nulla, e registrano se le chiamano. */
function depsFinte(over: Partial<WorktreeGcDeps> = {}): { deps: WorktreeGcDeps; toccati: string[] } {
  const toccati: string[] = [];
  const db = new Database(":memory:");
  db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, archived INTEGER, updated_at TEXT, assigned_topic_id TEXT)");
  db.run("CREATE TABLE task_comments (id TEXT PRIMARY KEY, task_id TEXT, created_at TEXT)");
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT)");
  db.run("CREATE TABLE messages (session_key TEXT, timestamp TEXT)");
  const deps: WorktreeGcDeps = {
    db,
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
  return { deps, toccati };
}

describe("il cablaggio della potatura dei worktree", () => {
  it("la fabbrica costruisce e pubblica i due tempi dell'avvio", () => {
    const { deps } = depsFinte();
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
    const { deps, toccati } = depsFinte();
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
    const { deps } = depsFinte({
      worktreeStore: { list: () => { throw new Error("store rotto"); } },
    });
    const gc = createWorktreeGcRunner(deps);
    expect(await gc.runWorktreeGc()).toBeNull();
  });

  it("lo sfoltimento di un task senza worktree e' un non-evento", async () => {
    const { deps, toccati } = depsFinte();
    const gc = createWorktreeGcRunner(deps);
    await gc.slimWorktreeOfTask("t-inesistente");
    expect(toccati).toEqual([]);
  });

  it("un turno IN VOLO ferma lo sfoltimento prima di guardare il disco", async () => {
    // La guardia piu' importante di `slimWorktreeOfTask`: togliere
    // `node_modules` sotto i piedi di un agente che sta lavorando.
    const letture: string[] = [];
    const { deps } = depsFinte({
      isInFlight: () => true,
      worktreeOfTask: (taskId) => { letture.push(taskId); return { id: "w1", absPath: "/tmp/x", projectId: "p" }; },
    });
    const gc = createWorktreeGcRunner(deps);
    await gc.slimWorktreeOfTask("t1");
    expect(letture).toEqual(["t1"]);   // ha risolto il worktree…
    // …e si e' fermato: nessuna chiamata al disco oltre l'esistenza.
  });
});
