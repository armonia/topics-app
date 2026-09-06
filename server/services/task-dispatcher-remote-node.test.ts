/**
 * LA CORSIA REMOTA: una card che gira su un'altra macchina.
 *
 * Two requirements meet in this file, and both are written against a defect
 * that costs real work:
 *
 *  · KANBAN-76 — a card whose `machine_id` names a paired node runs THERE.
 *    Not "preferably there": the local lane must never open a worktree, a
 *    topic or a turn for it, not even when the node is silent. A fallback to
 *    this machine is the one behaviour a human who picked a machine by hand
 *    did not ask for. And the slot it holds here does not spend the local cap:
 *    a remote run costs no process and no CPU on this side.
 *
 *  · KANBAN-77 — liveness is CONSECUTIVE FAILED POLLS, K = 30, never elapsed
 *    time. A closed laptop produces no polls at all, so twenty minutes of
 *    silence must bury exactly ZERO runs: a clock rule would bury every remote
 *    card the moment the lid opens. And a buried run is not a DEAD run - it may
 *    still be working over there - so the next run for the same card cancels it
 *    first, and a report carrying a buried run id is dropped. Without those two
 *    the card collects two deliveries and two branches.
 *
 * No network and no sleeps: the node is a fake, the clock is a variable, and
 * every poll is one `reconcile` call driven by hand.
 *
 * @covers KANBAN-76
 * @covers KANBAN-77
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps, NODE_DEAD_POLLS } from "./task-dispatcher";
import { createNodeBranchPlanter } from "./node-branch-plant";
import type { NodeRunReport } from "./node-client";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER,
    max_agents_auto INTEGER, dispatch_fanout INTEGER
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment',
    -- migration 20260904190855: l'ancora di KANBAN-72, qui è l'id del commento SUL NODO.
    message_id TEXT
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  db.run("INSERT INTO machines (id) VALUES ('node-1')");
  return db;
}

const PID = "alpha-abc123";
const TASK = "card-remota";
const MACHINE = "node-1";
const BASE_URL = "https://node.local";
const TOKEN = "tok-node-1";

/** Un report del nodo con i soli campi che il caso in prova guarda. */
function report(over: Partial<NodeRunReport> = {}): NodeRunReport {
  return {
    status: "in_progress",
    dispatchState: "working",
    dispatchError: null,
    comments: [],
    deliveryBranch: null,
    deliveryCommit: null,
    baseSha: null,
    stat: null,
    ...over,
  };
}

interface NodeFakeOptions {
  /** `null` = mai accoppiata: né indirizzo né token. */
  paired?: boolean;
  createRun?: () => Promise<{ runId: string }>;
  readRun?: (runId: string) => Promise<NodeRunReport>;
  bundle?: Uint8Array | null;
  planted?: { planted: boolean; commit: string | null; reason: string | null };
}

function nodeFake(o: NodeFakeOptions = {}) {
  const calls: string[] = [];
  const created: { body: unknown }[] = [];
  const plantedWith: { branch: string; baseSha: string | null; bundleBytes: number | null }[] = [];
  let nextRun = 0;
  const node: NonNullable<DispatcherDeps["node"]> = {
    createRun: async ({ body }) => {
      calls.push("create");
      created.push({ body });
      if (o.createRun) return o.createRun();
      nextRun += 1;
      return { runId: `run-${nextRun}` };
    },
    readRun: async ({ runId }) => {
      calls.push(`read:${runId}`);
      return o.readRun ? o.readRun(runId) : report();
    },
    fetchBundle: async () => {
      calls.push("bundle");
      return o.bundle && o.bundle.length > 0 ? { empty: false as const, bytes: o.bundle } : { empty: true as const };
    },
    cancelRun: async ({ runId }) => { calls.push(`cancel:${runId}`); },
    baseUrlOf: () => (o.paired === false ? null : BASE_URL),
    tokenOf: () => (o.paired === false ? null : TOKEN),
    nameOf: () => "Portatile",
    localMachineId: () => "questa-macchina",
    originUrlOf: async () => "git@github.com:acme/alpha.git",
    plantBranch: async ({ branch, baseSha, bundle }) => {
      plantedWith.push({ branch, baseSha, bundleBytes: bundle ? bundle.length : null });
      return o.planted ?? { planted: true, commit: "c0ffeec0ffee", reason: null };
    },
  };
  return { node, calls, created, plantedWith };
}

function harness(nodeOverrides: NodeFakeOptions = {}, depOverrides: Partial<DispatcherDeps> = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const fake = nodeFake(nodeOverrides);
  const worktrees: string[] = [];
  const topics: string[] = [];
  const turns: string[] = [];
  let now = Date.UTC(2026, 8, 6, 10, 0, 0);

  const deps: DispatcherDeps = {
    svc,
    resolveProject: () => ({ path: "/tmp/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      const id = `topic-${topics.length + 1}`;
      topics.push(id);
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [id]);
      return { topicId: id, sessionKey: `topic:${id}` };
    },
    createWorktree: async () => { worktrees.push(`wt-${worktrees.length + 1}`); return `wt-${worktrees.length}`; },
    deleteWorktree: async () => {},
    runTurn: (sessionKey) => { turns.push(sessionKey); return Promise.resolve<TurnEndInfo | void>(undefined); },
    broadcast: () => {},
    node: fake.node,
    now: () => now,
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
    ...depOverrides,
  };
  const dispatcher = createTaskDispatcher(deps);

  svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchFanOut: 1 });
  svc.setGlobalCap({ auto: false, max: 9 });

  return {
    db, svc, dispatcher, worktrees, topics, turns,
    calls: fake.calls, created: fake.created, plantedWith: fake.plantedWith,
    advance: (ms: number) => { now += ms; },
    nowMs: () => now,
    task: () => svc.get(TASK)!.task,
    comments: () => svc.get(TASK)!.comments,
    /** Un todo che nomina il nodo: è l'unica differenza con una card qualsiasi. */
    seed: () => {
      const ts = new Date(now).toISOString();
      db.run(
        `INSERT INTO tasks (id, project_id, text, description, status, created_at, updated_at, dispatch_attempts, machine_id)
         VALUES (?, ?, 'porta a casa la corsia remota', 'con il ramo', 'todo', ?, ?, 0, ?)`,
        [TASK, PID, ts, ts, MACHINE],
      );
    },
  };
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** Un giro di poll: è `reconcile` a interrogare il nodo, una volta per slot. */
async function poll(h: ReturnType<typeof harness>, giri = 1) {
  for (let i = 0; i < giri; i++) {
    await h.dispatcher.reconcile({ reason: "poll" });
    await flush();
  }
}

async function dispatch(h: ReturnType<typeof harness>) {
  await h.dispatcher.tick(PID);
  await flush();
}

describe("la card parte sul nodo, non qui", () => {
  it("nessun worktree, nessun discorso, nessun turno: solo la corsa sul nodo", async () => {
    const h = harness();
    h.seed();

    await dispatch(h);

    expect(h.worktrees).toEqual([]);
    expect(h.topics).toEqual([]);
    expect(h.turns).toEqual([]);
    expect(h.calls.filter((c) => c === "create")).toHaveLength(1);
    // Il nodo riconosce il repository dal remoto git, e la card dice da dove viene.
    expect(h.created[0].body).toMatchObject({ originTaskId: TASK, originUrl: "git@github.com:acme/alpha.git" });
    expect(h.task().status).toBe("in_progress");
    expect(h.task().dispatchState).toBe("working");
  });

  it("la card che nomina QUESTA macchina gira QUI, come sempre", async () => {
    // `machine_id` è la scelta di una macchina, e sceglier questa è il default
    // detto ad alta voce: senza questo caso la corsia remota aspetterebbe per
    // sempre un nodo che siamo noi, su una riga il cui `baseUrl` è null per
    // costruzione.
    const h = harness();
    h.db.run("INSERT INTO machines (id) VALUES ('questa-macchina')");
    h.seed();
    h.db.run("UPDATE tasks SET machine_id = 'questa-macchina' WHERE id = ?", [TASK]);

    await dispatch(h);

    expect(h.calls).toEqual([]);
    expect(h.worktrees).toHaveLength(1);
    expect(h.turns).toHaveLength(1);
  });

  it("una card remota in lavorazione NON spende il tetto locale", async () => {
    const h = harness();
    h.seed();

    await dispatch(h);

    expect(h.task().dispatchState).toBe("working");
    // `running` di GET /api/system/dispatch-capacity legge questo numero.
    expect(h.dispatcher.busyCount()).toBe(0);
    // Ma la card resta fra quelle in volo: il processo ci tiene una maniglia.
    expect(h.dispatcher.busyIds()).toContain(TASK);
  });

  it("nodo muto al dispatch: resta in coda con node_unreachable, e nessun turno qui", async () => {
    const h = harness({ createRun: () => Promise.reject(Object.assign(new Error("boom"), { reason: "unreachable" })) });
    h.seed();

    await dispatch(h);

    const t = h.task();
    expect(t.status).toBe("todo");
    expect(t.dispatchError).toBe("node_unreachable");
    expect(t.dispatchDeferredUntil).not.toBeNull();
    expect(Date.parse(t.dispatchDeferredUntil!)).toBeGreaterThan(Date.now());
    // Il tentativo speso dal claim torna indietro: il nodo spento non è un fallimento della card.
    expect(t.dispatchAttempts).toBe(0);
    expect(h.turns).toEqual([]);
    expect(h.worktrees).toEqual([]);
    expect(h.topics).toEqual([]);
  });

  it("nodo mai accoppiato: stessa risposta, senza nemmeno provare", async () => {
    const h = harness({ paired: false });
    h.seed();

    await dispatch(h);

    expect(h.calls).toEqual([]);
    expect(h.task().status).toBe("todo");
    expect(h.task().dispatchError).toBe("node_unreachable");
  });
});

describe("un nodo è vivo finché i suoi POLL rispondono", () => {
  it("venti minuti senza NESSUN poll non seppelliscono niente", async () => {
    const h = harness();
    h.seed();
    await dispatch(h);

    // La macchina dorme: l'orologio corre e nessuno interroga il nodo.
    h.advance(20 * 60_000);

    expect(h.task().status).toBe("in_progress");
    expect(h.task().dispatchState).toBe("working");
    expect(h.comments().some((c) => c.content.includes("non risponde più"))).toBe(false);

    // E al risveglio il primo giro risponde: la corsa è viva come prima.
    await poll(h);
    expect(h.task().status).toBe("in_progress");
  });

  it(`${NODE_DEAD_POLLS} giri falliti seppelliscono UNA volta, con una nota sola`, async () => {
    const h = harness({ readRun: () => Promise.reject(Object.assign(new Error("giù"), { reason: "unreachable" })) });
    h.seed();
    await dispatch(h);
    expect(h.task().dispatchAttempts).toBe(1);

    // Un giro prima del tetto: ancora niente.
    await poll(h, NODE_DEAD_POLLS - 1);
    expect(h.task().status).toBe("in_progress");

    // Il dispatch si spegne PRIMA dell'ultimo giro: la sepoltura sta nello
    // step 0 di `reconcile` e avviene comunque, ma la card non riparte subito
    // sul nodo, così quello che si misura è la sepoltura e non il giro dopo.
    h.svc.updateBoardSettings(PID, { autoDispatch: false });
    await poll(h);

    const t = h.task();
    expect(t.status).toBe("todo");
    expect(t.dispatchAttempts).toBe(0); // rimborsato, come gli orfani di KANBAN-10
    const note = h.comments().filter((c) => c.content.includes("non risponde più"));
    expect(note).toHaveLength(1);

    // E altri dieci giri non aggiungono una seconda nota: la corsa è già sepolta.
    await poll(h, 10);
    expect(h.comments().filter((c) => c.content.includes("non risponde più"))).toHaveLength(1);
  });

  it("un giro riuscito al ventinovesimo azzera il conto", async () => {
    let vivo = false;
    const h = harness({
      readRun: () => (vivo ? Promise.resolve(report()) : Promise.reject(new Error("giù"))),
    });
    h.seed();
    await dispatch(h);

    await poll(h, NODE_DEAD_POLLS - 1);
    expect(h.task().status).toBe("in_progress");

    // Il nodo risponde una volta: il conto riparte da zero.
    vivo = true;
    await poll(h);
    vivo = false;
    // Altri ventinove falliti non bastano più: senza l'azzeramento questo
    // giro sarebbe il trentesimo e la corsa sarebbe già sepolta.
    await poll(h, NODE_DEAD_POLLS - 1);

    expect(h.task().status).toBe("in_progress");
    expect(h.comments().some((c) => c.content.includes("non risponde più"))).toBe(false);
  });

  it("la corsa vecchia si cancella PRIMA di crearne una nuova, e il suo rapporto non torna più", async () => {
    // La corsa 1 non risponde e viene sepolta. Da quel momento «sepolta» la fa
    // rispondere di nuovo, e con una CONSEGNA: se qualcuno la interrogasse
    // ancora, la card raccoglierebbe un secondo ramo. La prova che il rapporto
    // è scartato è che quel ramo non arriva mai.
    let sepolta = false;
    const h = harness({
      readRun: (runId) => {
        if (runId !== "run-1") return Promise.resolve(report());
        return sepolta
          ? Promise.resolve(report({ status: "review", deliveryBranch: "ramo-della-corsa-sepolta", baseSha: "aaaaaaa1" }))
          : Promise.reject(Object.assign(new Error("giù"), { reason: "unreachable" }));
      },
    });
    h.seed();
    await dispatch(h);

    await poll(h, NODE_DEAD_POLLS);
    sepolta = true;

    // La sepoltura ha rimesso la card in coda e il `tick` dello stesso giro
    // l'ha ridispacciata: prima la cancellazione della vecchia, poi la nuova.
    const ordine = h.calls.filter((c) => c === "create" || c.startsWith("cancel:"));
    expect(ordine).toEqual(["create", "cancel:run-1", "create"]);
    expect(h.task().status).toBe("in_progress");

    // Da qui in avanti nessuno interroga più `run-1`: il rapporto tardivo di
    // una corsa sepolta non ha una porta da cui entrare.
    const dopo = h.calls.length;
    await poll(h, 3);
    expect(h.calls.slice(dopo).filter((c) => c === "read:run-1")).toEqual([]);
    expect(h.task().deliveryBranch).toBeNull();
  });
});

describe("lo specchio: stato, commenti e il ramo che torna", () => {
  it("un commento specchiato due volte si scrive UNA volta", async () => {
    let comments: NodeRunReport["comments"] = [
      { id: "nc-origine", author: "system", content: "Card specchiata da github.com/acme/alpha", kind: "service", createdAt: "2026-09-06T10:00:00.000Z" },
    ];
    const h = harness({ readRun: () => Promise.resolve(report({ comments })) });
    h.seed();
    await dispatch(h);

    // Primo giro: semina soltanto. La nota d'origine del nodo è il nostro
    // stesso dispatch di ritorno, e rispecchiarla sarebbe rumore.
    await poll(h);
    expect(h.comments().some((c) => c.content.includes("Card specchiata"))).toBe(false);

    comments = [
      ...comments,
      { id: "nc-1", author: "agent", content: "Ho finito il primo pezzo.", kind: "service", createdAt: "2026-09-06T10:01:00.000Z" },
    ];
    await poll(h);
    await poll(h); // lo stesso commento, di nuovo

    const mirrored = h.comments().filter((c) => c.content === "Ho finito il primo pezzo.");
    expect(mirrored).toHaveLength(1);
    // La deduplica passa dall'ANCORA (KANBAN-72), non dal testo.
    expect(mirrored[0].messageId).toBe("nc-1");
  });

  it("la card del nodo in review pianta il ramo e registra la consegna", async () => {
    const bundle = new Uint8Array([1, 2, 3, 4]);
    const h = harness({
      bundle,
      readRun: () =>
        Promise.resolve(report({
          status: "review",
          dispatchState: "delivered",
          deliveryBranch: "topics/corsa-remota",
          deliveryCommit: "deadbeefdeadbeef",
          baseSha: "abcdef0123456789",
          stat: { filesChanged: 3, insertions: 40, deletions: 2 },
        })),
    });
    h.seed();
    await dispatch(h);

    await poll(h);

    const t = h.task();
    expect(t.status).toBe("review");
    expect(t.deliveryBranch).toBe("topics/corsa-remota");
    expect(t.deliveryCommit).toBe("c0ffeec0ffee"); // il commit DAVVERO piantato qui
    expect(t.deliveryFilesChanged).toBe(3);
    // Il ramo è arrivato come bundle sul canale già autenticato.
    expect(h.plantedWith).toEqual([{ branch: "topics/corsa-remota", baseSha: "abcdef0123456789", bundleBytes: 4 }]);
    // UNA nota sola, e nomina il nodo.
    const note = h.comments().filter((c) => c.content.includes("Portatile"));
    expect(note.length).toBeGreaterThanOrEqual(1);
    expect(h.comments().some((c) => c.content.includes("piantato in questo checkout"))).toBe(true);
    // Lo slot si libera: la corsa è finita.
    expect(h.dispatcher.busyIds()).not.toContain(TASK);
  });

  it("il ramo che non si pianta arriva comunque in review, col motivo scritto", async () => {
    const h = harness({
      bundle: new Uint8Array([9, 9]),
      planted: { planted: false, commit: null, reason: "il commit di base 1234abcd non è in questo checkout" },
      readRun: () =>
        Promise.resolve(report({ status: "review", deliveryBranch: "topics/corsa-remota", baseSha: "1234abcd" })),
    });
    h.seed();
    await dispatch(h);

    await poll(h);

    expect(h.task().status).toBe("review");
    expect(h.task().deliveryBranch).toBeNull();
    expect(h.comments().some((c) => c.content.includes("il commit di base 1234abcd non è in questo checkout"))).toBe(true);
  });
});

describe("il bundle presuppone il commit di base", () => {
  it("base assente: niente fetch, niente ripiego a storia intera, un motivo da leggere", async () => {
    const eseguiti: string[][] = [];
    const planter = createNodeBranchPlanter({
      repoPathOf: () => "/tmp/alpha",
      runGit: async (_cwd, args) => {
        eseguiti.push(args);
        // `cat-file -e` dice di no: questo checkout non ha il commit di base.
        if (args[0] === "cat-file") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      writeBundle: async () => ({ file: "/tmp/x.bundle", cleanup: async () => {} }),
    });

    const out = await planter.plantBranch({
      projectId: PID,
      branch: "topics/corsa-remota",
      baseSha: "abcdef0123456789",
      bundle: new Uint8Array([1, 2, 3]),
    });

    expect(out.planted).toBe(false);
    expect(out.reason).toContain("abcdef01");
    // Il punto della regola: nessun fetch, e nessuna richiesta di un bundle intero.
    expect(eseguiti.some((a) => a[0] === "fetch")).toBe(false);
    expect(eseguiti.map((a) => a[0])).toEqual(["cat-file"]);
  });
});
