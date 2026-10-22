/**
 * Fan-out: lo STESSO task a N agenti in worktree paralleli.
 *
 * File a sé e non un `describe` in più dentro `task-dispatcher.test.ts` per una
 * ragione meccanica: quell'harness ha UNA sola coppia `resolveTurn/rejectTurn`,
 * cioè può tenere un turno vivo per volta. Un fan-out ne ha N insieme per
 * definizione, quindi qui i turni sono una MAPPA per sessionKey e si chiudono
 * uno alla volta, che è anche l'unico modo di provare quello che conta: il
 * confronto si scrive quando ha finito l'ULTIMO, non il primo.
 *
 * @covers KANBAN-13
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { createTaskAttemptStore, type TaskAttempt } from "./task-attempts";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

/** Schema autoportante: sottoinsieme delle migration rilevanti + la 065. */
function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL); // migration 100 — rowToTask la legge per OGNI task
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
    -- migration 20260904190855: the assistant row an agent said this in.
    message_id TEXT
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  db.run(`CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, topic_id TEXT, worktree_id TEXT, branch TEXT, model TEXT,
    state TEXT NOT NULL DEFAULT 'running',
    commit_sha TEXT, files_changed INTEGER, insertions INTEGER, deletions INTEGER,
    summary TEXT, error TEXT,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, ended_at TEXT, selected_at TEXT,
    UNIQUE (task_id, idx)
  )`);
  return db;
}

const PID = "alpha-abc123";

let seq = 0;
function seedTask(db: Database, o: { id?: string; status?: string; dispatchState?: string | null; assignedTopicId?: string | null; attempts?: number } = {}): string {
  const id = o.id ?? `t${++seq}`;
  const ts = new Date(Date.now() + ++seq).toISOString();
  if (o.assignedTopicId) db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [o.assignedTopicId]);
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, assigned_topic_id, dispatch_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, PID, "task " + id, o.status ?? "todo", ts, ts, o.attempts ?? 0, o.assignedTopicId ?? null, o.dispatchState ?? null],
  );
  return id;
}

/** Quanto "ha prodotto" un worktree, deciso dal test (nessun git vero). */
type Stat = { commit: string | null; filesChanged: number; insertions: number; deletions: number };
const WORK: Stat = { commit: "c0ffee", filesChanged: 3, insertions: 40, deletions: 4 };
const NOTHING: Stat = { commit: null, filesChanged: 0, insertions: 0, deletions: 0 };

function harness(overrides: Partial<DispatcherDeps> = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const attempts = createTaskAttemptStore(db);
  const events: any[] = [];
  const worktreesCreated: string[] = [];
  const worktreesDeleted: string[] = [];
  const topicsArchived: string[] = [];
  const topicsCreated: { name: string; worktreeId?: string; model?: string }[] = [];
  const turns: { sessionKey: string; content: string }[] = [];
  /** Un resolver PER TURNO: un fan-out ne ha N vivi insieme. */
  const pending = new Map<string, (info?: TurnEndInfo) => void>();
  /** Cosa risponderà `attemptStats` per un dato worktree (default: ha lavorato). */
  const stats = new Map<string, Stat>();

  const deps: DispatcherDeps = {
    svc,
    attempts,
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    createTopic: (opts) => {
      topicsCreated.push({ name: opts.name, worktreeId: opts.worktreeId, model: opts.model });
      const n = topicsCreated.length;
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${n}`]);
      return { topicId: `topic-${n}`, sessionKey: `topic:sk${n}` };
    },
    createWorktree: async (storeId) => {
      const id = `wt-${worktreesCreated.length + 1}`;
      worktreesCreated.push(storeId);
      return id;
    },
    deleteWorktree: async (id) => { worktreesDeleted.push(id); },
    worktreeBranch: (id) => `task/${id}`,
    attemptStats: async (id) => stats.get(id) ?? WORK,
    archiveTopic: (id) => { topicsArchived.push(id); },
    getLastAgentText: (sk) => ({ text: `riassunto di ${sk}`, id: `m-${sk}` }),
    runTurn: (sessionKey, content) =>
      new Promise<TurnEndInfo | void>((res) => { turns.push({ sessionKey, content }); pending.set(sessionKey, res); }),
    broadcast: (m) => events.push(m),
    graceMs: 10,
    retryBackoffMs: 0,
    log: () => {},
    ...overrides,
  };
  const dispatcher = createTaskDispatcher(deps);
  return {
    db, svc, dispatcher, attempts, events, turns, stats,
    worktreesCreated, worktreesDeleted, topicsArchived, topicsCreated,
    /** Chiude UN turno per sessionKey (l'ordine è il punto del test). */
    finish: (sessionKey: string, info?: TurnEndInfo) => { pending.get(sessionKey)?.(info); pending.delete(sessionKey); },
    finishAll: () => { for (const [, res] of pending) res(); pending.clear(); },
    task: (id: string) => svc.get(id)?.task,
    comments: (id: string) => (svc.get(id)?.comments ?? []).map((c) => c.content),
    rows: (id: string): TaskAttempt[] => attempts.list(id),
  };
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

/**
 * Board con fan-out acceso. `cap` è il tetto di concorrenza GLOBALE (riga '*'),
 * l'unico che esista: è quello che conta per il dispatcher, e senza scriverlo
 * resterebbe al default 2 — cioè ogni fan-out da 3 arriverebbe a 2 e il test
 * misurerebbe il default invece della logica.
 */
function boardWithFanOut(h: ReturnType<typeof harness>, fanOut: number, o: { cap?: number; useWorktree?: boolean } = {}) {
  h.svc.updateBoardSettings(PID, {
    autoDispatch: true,
    dispatchUseWorktree: o.useWorktree ?? true,
    dispatchFanOut: fanOut,
  });
  h.svc.setGlobalCap({ auto: false, max: o.cap ?? 5 });
}

describe("task-dispatcher fan-out", () => {
  it("lancia N tentativi: N worktree, N chat, N turni, e UNA sola riga in_progress", async () => {
    const h = harness();
    boardWithFanOut(h, 3);
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.turns.length).toBe(3);
    expect(h.worktreesCreated.length).toBe(3);
    expect(h.topicsCreated.map((t) => t.name)).toEqual([
      "task t1 · tentativo 1", "task t1 · tentativo 2", "task t1 · tentativo 3",
    ]);
    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");
    expect(t.dispatchState).toBe("working");
    // Il deep-link del task punta al tentativo 1 finché l'umano non sceglie.
    expect(t.assignedTopicId).toBe("topic-1");
    const rows = h.rows("t1");
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.state === "running")).toBe(true);
    expect(rows.map((r) => r.branch)).toEqual(["task/wt-1", "task/wt-2", "task/wt-3"]);
  });

  it("il kickoff dice che il repo e' PUBBLICO, prima che l'agente scriva un nome", async () => {
    // ALL'ORIGINE, non al sintomo. Il nome vero di una persona e' finito nei
    // commenti di file tracciati due volte in una notte: il cancello
    // `no-personal-data` li ha fermati, qualcuno l'ha tolto a mano, e il turno
    // dopo un altro agente l'ha riscritto. Toglierlo ogni volta cura il
    // sintomo; la causa e' che nessuno gliel'aveva detto PRIMA, e l'unica cosa
    // che un agente legge davvero e' questo envelope — CLAUDE.md nelle worktree
    // non esiste.
    const h = harness();
    boardWithFanOut(h, 1);
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();

    const k = h.turns[0].content;
    expect(k).toContain("THE REPO IS PUBLIC");
    // Le due meta' che servono: cosa non scrivere, e cosa scrivere al posto.
    expect(k).toContain("not in comments either");
    expect(k).toContain("the ROLE");
    // E il cancello nominato, perche' un divieto senza il suo controllo si
    // legge come un consiglio.
    expect(k).toContain("no-personal-data-tracked");
  });

  it("il kickoff del tentativo dice che è uno di N e VIETA di muovere il task", async () => {
    const h = harness();
    boardWithFanOut(h, 2);
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();

    const k = h.turns[1].content;
    expect(k).toContain("ATTEMPT 2 of 2");
    expect(k).toContain("Do NOT move the task's status");
    expect(k).toContain("Do NOT write in the task thread");
    expect(k).toContain("COMMIT everything on your branch");
    // Il divieto è su main, non sulla BASE del proprio ramo. La vecchia formula
    // ("nessun rebase su main") vietava anche il gesto che RISOLVE il conflitto
    // di land, e tre card in un pomeriggio ci sono rimaste incastrate.
    expect(k).toContain("DO NOT TOUCH main");
    expect(k).toContain("git rebase main");
    expect(k).not.toContain("no rebase");
    // Il contratto normale ("sei l'owner, porta in review") NON deve comparire:
    // due contratti opposti nello stesso prompt = il modello ne sceglie uno a caso.
    expect(k).not.toContain("exclusive owner of task");
  });

  /**
   * I QUATTRO cancelli, su una board che NON dichiara nessun comando.
   *
   * È la regressione dell'11/08: il kickoff nominava i cancelli solo dentro il
   * ramo `reviewChecks`, nessuna board ne dichiarava, quindi tre card di fila
   * hanno lasciato main con `check:deadcode` rosso — sempre per uno script che
   * si lancia a mano e che nessuno importa. `boardWithFanOut` non tocca
   * `reviewChecks`: se questo test passa, i quattro nomi ci sono per default.
   *
   * I nomi si scrivono a mano e non si interpolano da `CODE_GATES_RULE`: un
   * test che cerca la costante che ha appena interpolato non può fallire.
   */
  it("il kickoff del tentativo nomina i QUATTRO cancelli anche senza check dichiarati", async () => {
    const h = harness();
    boardWithFanOut(h, 2);
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();

    const k = h.turns[0].content;
    for (const gate of ["typecheck", "lint", "check:deadcode", "test:unit"]) expect(k).toContain(gate);
    // E la regola che rende verde il terzo: lo script a mano si DICHIARA.
    expect(k).toContain("knip.jsonc");
    expect(k).toContain("scripts/disk-report.ts!");
  });

  /**
   * Il bump di versione, nominato come GESTO nel kickoff.
   *
   * Stessa forma della regressione qui sopra, un giorno dopo: il cancello
   * `version-lockstep` prendeva i bump fatti a mano (due volte in una notte, sul
   * `Cargo.lock` entrambe le volte) ma nessun testo diceva quale comando li
   * evita, quindi l'umano riallineava a mano e il giro si ripeteva.
   *
   * Anche qui i nomi si scrivono a mano invece di interpolare `VERSION_BUMP_RULE`:
   * un test che cerca la costante che ha appena interpolato non può fallire.
   */
  it("il kickoff nomina il gesto del bump, non i file da aprire", async () => {
    const h = harness();
    boardWithFanOut(h, 2);
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();

    const k = h.turns[0].content;
    expect(k).toContain("bun run bump");
    expect(k).toContain("bun run bump sync");
    // Il PERCHÉ, non solo il comando: il posto dimenticato è quello generato.
    expect(k).toContain("lockfile");
  });

  it("il confronto si scrive quando ha finito l'ULTIMO tentativo, non il primo", async () => {
    const h = harness();
    boardWithFanOut(h, 2);
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();

    h.finish("topic:sk1");
    await flush();
    expect(h.task("t1")!.status).toBe("in_progress"); // il giro è ancora aperto

    h.finish("topic:sk2");
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("review");
    expect(t.deliveredBy).toBe("system");
    expect(t.deliveredReason).toBe("fanout");
    const thread = h.comments("t1").join("\n");
    expect(thread).toContain("Fan-out chiuso: 2 tentativi, 2 con modifiche");
    expect(thread).toContain("**Tentativo 1** · 3 file · +40 −4");
    expect(thread).toContain("riassunto di topic:sk1");
    expect(h.rows("t1").every((r) => r.state === "delivered")).toBe(true);
    // Nessun worktree potato: sono tutti in gara finché l'umano non sceglie.
    expect(h.worktreesDeleted).toEqual([]);
  });

  it("un tentativo in timeout tiene comunque il lavoro che aveva committato", async () => {
    const h = harness();
    boardWithFanOut(h, 2);
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();

    h.finish("topic:sk1", { end: "max_tokens" } as TurnEndInfo);
    h.finish("topic:sk2");
    await flush();

    const [a1, a2] = h.rows("t1");
    expect(a1.state).toBe("failed");
    expect(a1.error).toBeTruthy();
    expect(a1.commit).toBe("c0ffee");     // la fotografia si scatta comunque
    expect(a1.filesChanged).toBe(3);
    expect(a2.state).toBe("delivered");
    // Ha prodotto lavoro: il task entra in review lo stesso, con entrambi in gara.
    expect(h.task("t1")!.status).toBe("review");
  });

  it("nessun tentativo ha committato: niente review, tutto potato e task rimesso in coda", async () => {
    const h = harness();
    boardWithFanOut(h, 2);
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.stats.set("wt-1", NOTHING);
    h.stats.set("wt-2", NOTHING);

    h.finishAll();
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("todo");        // rimesso in coda, non consegnato
    expect(t.deliveredBy).toBeNull();
    expect(h.comments("t1").join("\n")).toContain("nessuno ha prodotto modifiche committate");
    expect(h.worktreesDeleted.sort()).toEqual(["wt-1", "wt-2"]);
    // L'insieme, non la lista: il topic LEGATO al task viene archiviato due
    // volte — una dal ritiro al rilascio, una dalla potatura dei tentativi — e
    // va bene, perché `archiveTopicFully` è convergente (un topic già
    // archiviato non riscrive il flag né ribroadcasta). Il contratto è «questi
    // topic finiscono archiviati», non «archiveTopic è chiamata una volta
    // sola»: asserire il conteggio legherebbe il test al numero di percorsi
    // interni invece che all'esito.
    expect([...new Set(h.topicsArchived)].sort()).toEqual(["topic-1", "topic-2"]);
  });

  it("il fan-out paga N slot del tetto: gli altri todo aspettano il tick dopo", async () => {
    const h = harness();
    boardWithFanOut(h, 3, { cap: 3 });
    seedTask(h.db, { id: "t1", status: "todo" });
    seedTask(h.db, { id: "t2", status: "todo" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.turns.length).toBe(3);       // solo t1, ma tre volte
    expect(h.task("t1")!.status).toBe("in_progress");
    expect(h.task("t2")!.status).toBe("todo");
  });

  it("il tetto stringe il fan-out invece di rifiutarlo, e lo dice", async () => {
    const h = harness();
    boardWithFanOut(h, 3, { cap: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.turns.length).toBe(2);
    expect(h.rows("t1").length).toBe(2);
    expect(h.comments("t1").join("\n")).toContain("Fan-out 3→2");
  });

  it("senza worktree il fan-out non parte: un agente solo, in-place, con una nota", async () => {
    const h = harness();
    boardWithFanOut(h, 3, { useWorktree: false });
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.turns.length).toBe(1);
    // UN tentativo, non zero. Dal 2026-08-16 anche il lancio singolo lascia la
    // sua riga in `task_attempts`: quella tabella aveva diciannove colonne e
    // zero righe perche' la scriveva solo il fan-out, e senza lo storico del
    // dispatch normale non c'era modo di sapere perche' una card rimbalza.
    // Quello che questo caso difende resta il numero di TURNI: senza worktree
    // il fan-out non parte, e l'agente e' uno solo.
    expect(h.rows("t1").length).toBe(1);
    expect(h.turns[0].content).toContain("exclusive owner of task");
    expect(h.comments("t1").join("\n")).toContain("board IN-PLACE");
  });

  it("host senza store dei tentativi: fanOut resta 1, nessuno se ne accorge", async () => {
    const h = harness({ attempts: undefined });
    boardWithFanOut(h, 4);
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.turns.length).toBe(1);
    expect(h.turns[0].content).toContain("exclusive owner of task");
  });

  it("riavvio a metà giro: chiude i tentativi orfani con ciò che i worktree hanno salvato", async () => {
    const h = harness();
    boardWithFanOut(h, 2);
    const id = seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-1", dispatchState: "working", attempts: 1 });
    // Due tentativi rimasti `running` dal processo morto: i worktree, però, ci sono.
    const a1 = h.attempts.create({ taskId: id, idx: 1 });
    h.attempts.bind(a1.id, { topicId: "topic-1", worktreeId: "wt-1", branch: "task/wt-1" });
    const a2 = h.attempts.create({ taskId: id, idx: 2 });
    h.attempts.bind(a2.id, { topicId: "topic-2", worktreeId: "wt-2", branch: "task/wt-2" });

    await h.dispatcher.reconcile();
    await flush();

    const rows = h.rows("t1");
    expect(rows.every((r) => r.state !== "running")).toBe(true);
    expect(rows[0].error).toContain("il server è ripartito");
    expect(rows[0].commit).toBe("c0ffee");            // il worktree è sopravvissuto
    const t = h.task("t1")!;
    expect(t.status).toBe("review");                  // c'è lavoro: si consegna
    expect(t.deliveredReason).toBe("fanout");
    expect(h.comments("t1").join("\n")).toContain("Il server è ripartito mentre 2");
  });

  it("un lancio singolo chiude il tentativo rimasto `running` dalla sessione che sostituisce: al boot non e' un fratello del fan-out", async () => {
    // 1929291c, 2026-09-04 18:03: the morning session's row was still `running`
    // (the server had died mid-turn), the card was re-dispatched on a new topic,
    // and the next boot read the stale row as a fan-out sibling: round closed,
    // card sent to review "senza riassunto" while its agent was working.
    const h = harness();
    boardWithFanOut(h, 1);
    const id = seedTask(h.db, { id: "t1", status: "todo" });
    const stale = h.attempts.create({ taskId: id, idx: 1 });
    h.attempts.bind(stale.id, { topicId: "topic-old", worktreeId: "wt-old", branch: "task/wt-old" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.turns.length).toBe(1);
    const rows = h.rows("t1");
    expect(rows.map((r) => `${r.idx}:${r.state}`).join(",")).toBe("1:failed,2:running");
    const old = rows.find((r) => r.id === stale.id)!;
    expect(old.state).toBe("failed");
    expect(old.error).toContain("sostituito");
    expect(rows.filter((r) => r.state === "running").length).toBe(1);

    await h.dispatcher.reconcile();
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");
    expect(h.comments("t1").join("\n")).not.toContain("tentativo del fan-out");
  });

  it("riavvio con UN solo tentativo vivo, sul topic della card: e' una sessione singola e riprende, niente worktree buttato", async () => {
    // Before 2026-09-04 this was read as an orphaned round and closed "without
    // a commit": card requeued, worktree reaped, uncommitted work gone. A lone
    // running row on the task's own topic is exactly what a single launch
    // leaves behind (its history row), so it resumes like one.
    const h = harness();
    boardWithFanOut(h, 2);
    const id = seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-1", dispatchState: "working", attempts: 1 });
    const a1 = h.attempts.create({ taskId: id, idx: 1 });
    h.attempts.bind(a1.id, { topicId: "topic-1", worktreeId: "wt-1" });
    h.stats.set("wt-1", NOTHING);

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");
    expect(t.assignedTopicId).toBe("topic-1");
    expect(t.dispatchAttempts).toBe(1);
    expect(h.worktreesDeleted).toEqual([]);
  });

  it("un giro nuovo pota i worktree del giro precedente prima di aprirne altri", async () => {
    const h = harness();
    boardWithFanOut(h, 2);
    const id = seedTask(h.db, { id: "t1", status: "todo" });
    // Residuo di un giro rifiutato in review e rimandato in todo.
    const old = h.attempts.create({ taskId: id, idx: 1 });
    h.attempts.bind(old.id, { topicId: "topic-vecchio", worktreeId: "wt-vecchio" });
    h.attempts.finish(old.id, { state: "delivered", commit: "abc", filesChanged: 1 });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.worktreesDeleted).toContain("wt-vecchio");
    expect(h.topicsArchived).toContain("topic-vecchio");
    expect(h.rows("t1").length).toBe(2);              // solo i nuovi
  });
});

// ── La guardia contro la perdita dei commit ────────────────────────────────
//
// Il cleanup dopo il turno presume che un tentativo rimesso in coda non abbia
// prodotto niente. È vero quasi sempre, e falso proprio nel caso che fa danno:
// l'agente committa, POI il turno viene troncato dall'infrastruttura, il task
// torna in `todo`, e `deleteWorktree` porta via anche il BRANCH — commit
// compresi (worktree-manager: mode "branch" ⇒ `git branch -D`).
describe("cleanup del worktree — non buttare via i commit", () => {
  it("tentativo rimesso in coda SENZA lavoro: si pulisce (comportamento invariato)", async () => {
    const h = harness({ worktreeHasWork: async () => false });
    boardWithFanOut(h, 2);
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.stats.set("wt-1", NOTHING);
    h.stats.set("wt-2", NOTHING);
    h.finishAll();
    await flush();
    expect(h.worktreesDeleted.sort()).toEqual(["wt-1", "wt-2"]);
  });

  it("il reap dei tentativi PERDENTI resta invariato anche se hanno lavoro", async () => {
    // Qui lo scarto è deliberato: l'umano (o la regola del fan-out) ha deciso.
    // Tutelarli sarebbe accumulo, non tutela — la guardia NON deve applicarsi.
    const h = harness({ worktreeHasWork: async () => true });
    boardWithFanOut(h, 2);
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.stats.set("wt-1", NOTHING);
    h.stats.set("wt-2", NOTHING);
    h.finishAll();
    await flush();
    expect(h.worktreesDeleted.sort()).toEqual(["wt-1", "wt-2"]);
  });

  it("senza la sonda il comportamento è quello storico (host non aggiornato)", async () => {
    const h = harness(); // nessun worktreeHasWork
    boardWithFanOut(h, 2);
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.stats.set("wt-1", NOTHING);
    h.stats.set("wt-2", NOTHING);
    h.finishAll();
    await flush();
    expect(h.worktreesDeleted.sort()).toEqual(["wt-1", "wt-2"]);
  });
});

// NOTE: the path that really lost commits (ONE agent, turn truncated, task put
// back in `todo`, worktree deleted with its BRANCH) IS pinned now, but not here:
// `task-dispatcher-preserve-work.test.ts` covers `preserveWork` directly.
//
// It stays out of THIS harness because the missing ingredient was never the
// turn, it was the CARD. Every single-agent variant tried here (fanOut 1, a
// runTurn that rejects, the retry budget spent) lands somewhere else: in `review`
// by system delivery, or without a worktree at all. The tests written for it
// passed without touching the guard, so they were deleted rather than left green
// and empty. Getting to `todo` with a worktree already created needs a parent
// whose subtask is still IN FLIGHT, which is what the other file sets up.
//
// What the three tests above prove is the NON-regression: the reap of the losing
// attempts keeps deleting even when the probe reports work, because there the
// discard is deliberate.

// ── Il topic dell'agente si ritira col task ────────────────────────────────
//
// `releaseAndEmit` ora archivia il topic legato al task prima di slegarlo:
// `release()` toglieva il legame e il topic restava «aperto» per sempre —
// nessun umano lo chiuderà mai come tab (non è una sua tab) e la potatura dei
// tentativi copre solo i fan-out. È così che il topic di un agente parcheggiato
// a metà luglio è rimasto in giro fino ad agosto, contato fra le conversazioni
// vive.
//
// NON C'È UN TEST DEDICATO, e lo dico invece di lasciarne uno verde a vuoto.
// Il percorso da coprire è il rilascio di un agente SOLO (righe 981 e 1357 del
// dispatcher: fine turno senza consegna, e park dopo i tentativi). Ho provato a
// raggiungerlo con questo harness in tre modi — turno che rigetta, nessuna
// parola dell'agente, tentativi esauriti — e ogni variante finisce altrove: o
// in `review` per consegna di sistema, o con il task ancora `in_progress`. I
// test che ne erano usciti passavano SENZA toccare l'hook, cioè non provavano
// niente.
//
// Quello che il test qui sopra («nessun tentativo ha committato») prova è che
// l'hook FIRA: è per causa sua che `topicsArchived` contiene un doppione, ed è
// il motivo per cui quell'asserzione è diventata sull'insieme.

/**
 * LO STORICO DEL DISPATCH NORMALE.
 *
 * `task_attempts` ha diciannove colonne e ha avuto ZERO righe fino al
 * 2026-08-16: la scriveva solo il fan-out, che e' il caso raro, mentre il
 * dispatch singolo — la quasi totalita' dei lanci — non lasciava traccia.
 * Il conto lo si e' pagato quando e' servito capire perche' il 40% delle uscite
 * dalla review torna indietro: senza storico non c'e' modo di sapere perche' una
 * card ha rimbalzato quattro volte, e ogni vista costruita su quella tabella
 * mostrava zero sembrando che andasse tutto bene.
 *
 * I casi qui sotto sono i tre che rendono lo storico utile invece che presente:
 * la riga ESISTE, dice com'e' finito il turno, e distingue una consegna da un
 * timeout — che e' la distinzione che ha aperto la card (due tentativi tagliati
 * a 1.800.0xx ms tondi sembravano pronti e non lo erano).
 */
describe("storico: anche un dispatch singolo lascia la sua riga", () => {
  const simpleBoard = (h: ReturnType<typeof harness>) => {
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true });
    h.svc.setGlobalCap({ auto: false, max: 5 });
  };

  it("un lancio riuscito scrive UNA riga, legata al suo topic e al suo ramo", async () => {
    const h = harness();
    simpleBoard(h);
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    await flush();
    h.finishAll();
    await flush();

    const [r] = h.rows("t1");
    expect(r).toBeDefined();
    // Le colonne che rendono la riga un deep-link e non un contatore: senza
    // topic e ramo lo storico dice «e' successo qualcosa» e non «dove».
    expect(r.topicId).toBe("topic-1");
    expect(r.worktreeId).toBe("wt-1");
    expect(r.branch).toBe("task/wt-1");
    expect(r.idx).toBe(1);
    expect(r.state).toBe("delivered");
    // `agent_ms` popolato: e' la colonna con cui si riconosce un taglio al
    // timeout, ed era quella che mancava per diagnosticare il rimbalzo.
    expect(r.agentMs).toBeGreaterThanOrEqual(0);
    expect(r.endedAt).toBeTruthy();
    expect(r.summary).toContain("riassunto di");
  });

  it("un turno TAGLIATO non e' una consegna, e la riga lo dice", async () => {
    // Il caso della card: due tentativi con agent_ms a 1.800.0xx, cioe' il
    // timeout tondo. Sembravano pronti perche' erano in review, e non lo erano.
    const h = harness();
    simpleBoard(h);
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    await flush();
    h.finish("topic:sk1", { end: "cancelled", cause: "watchdog" });
    await flush();

    const [r] = h.rows("t1");
    expect(r.state).toBe("failed");
    // Il PERCHE' e' scritto: senza, «failed» non distingue un agente che ha
    // sbagliato da uno a cui e' finito il tempo.
    expect(r.error).toBeTruthy();
  });

  it("un RESUME non e' un tentativo nuovo: stessa sessione, stessa riga", async () => {
    // La distinzione che tiene utile lo storico. Un `resume` — l'agente riprende
    // la stessa sessione dopo una risposta umana o un nudge post-timeout — e' un
    // TURNO in piu' dentro lo stesso tentativo, e non deve produrre una riga
    // nuova: contarlo come tentativo direbbe «questa card e' stata affrontata da
    // capo cinque volte» quando l'agente non ha mai smesso di lavorarci, ed e'
    // esattamente la domanda a cui lo storico deve rispondere.
    const h = harness();
    simpleBoard(h);
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    await flush();
    h.finish("topic:sk1", { end: "cancelled", cause: "watchdog" });
    await flush(40);

    // Il dispatcher riprende da solo (nudge post-timeout) sulla stessa sessione.
    await h.dispatcher.tick(PID);
    await flush(20);
    h.finishAll();
    await flush();

    // Due turni, un tentativo solo.
    expect(h.turns.length).toBeGreaterThanOrEqual(2);
    const righe = h.rows("t1");
    expect(righe.length).toBe(1);
    expect(righe[0].idx).toBe(1);
    // E resta com'era finito il turno che l'ha chiuso: uno storico che si
    // riscrive a ogni ripresa non e' storico.
    expect(righe[0].state).toBe("failed");
  });

  it("una traccia non fa mai fallire il lavoro che sta tracciando", async () => {
    // Store che esplode a ogni scrittura: il dispatch deve andare avanti
    // comunque. Il caso contrario — un turno perso perche' non si e' potuto
    // annotarlo — sarebbe peggio del non avere lo storico.
    const rotto = {
      create: () => { throw new Error("disco pieno"); },
      get: () => null, list: () => { throw new Error("disco pieno"); }, bind: () => null, finish: () => null,
      runningCount: () => 0, select: () => null, clear: () => {},
    };
    const h = harness({ attempts: rotto as never });
    simpleBoard(h);
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    await flush();
    h.finishAll();
    await flush();

    // Il turno e' partito ed e' arrivato in fondo: e' tutto quello che conta.
    // (Il conteggio esatto dei turni non e' il soggetto qui: con lo store rotto
    // il fan-out gate non sa dire quanti tentativi ci sono, e va bene cosi'.)
    expect(h.turns.length).toBeGreaterThanOrEqual(1);
    expect(h.task("t1")?.status).not.toBe("todo");
  });
});
