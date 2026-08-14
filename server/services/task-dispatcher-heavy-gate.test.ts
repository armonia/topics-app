/**
 * IL FRENO DEL PESO: chi lo fa scattare, e per quanto.
 *
 * Due guasti misurati la notte del 12/08 su questo host, entrambi con la stessa
 * radice — la guardia che tiene fermo un task PESANTE guardava il numero
 * sbagliato e non aveva scadenza:
 *
 *  1. Il gate leggeva `load1`, cioè la coda di esecuzione dell'INTERA macchina.
 *     Il load stava fra 37 e 48, ma gli agenti usavano 75% su 1200% di CPU: il
 *     carico erano le app dell'umano (un logger acceso da sei giorni, il
 *     browser, la chat, un player). Il freno frenava NOI per colpa di altri.
 *  2. La coda è ordinata per priorità e poi per anzianità, e il ramo trattenuto
 *     fa `break`: un pesante con priorità alta si piazza in testa, trova il
 *     gate chiuso, e ferma l'INTERA board. Misurato: due `in_progress` col
 *     tetto a 9, per ore. Abbassando a mano la priorità dei due pesanti gli
 *     `in_progress` sono passati da 2 a 5 in pochi secondi.
 *
 * Il `break` resta VOLUTO, e questi test non lo tolgono: se i leggeri passassero
 * davanti alzerebbero il carico, e il momento in cui la macchina è scarica non
 * arriverebbe mai. Quello che cambia è QUALE carico guarda il gate, e il fatto
 * che l'attesa adesso finisce.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { createTaskAttemptStore } from "./task-attempts";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
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
    kind TEXT NOT NULL DEFAULT 'comment'
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
/** Un todo con priorità e peso scritti a mano: sono i due assi della coda. */
function seedTask(
  db: Database,
  o: { id: string; priority?: number; weight?: "light" | "heavy" | null },
): string {
  const ts = new Date(Date.now() + ++seq).toISOString();
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority, dispatch_weight)
     VALUES (?, ?, ?, 'todo', ?, ?, 0, ?, ?)`,
    [o.id, PID, "task " + o.id, ts, ts, o.priority ?? 2, o.weight ?? null],
  );
  return o.id;
}

function harness(overrides: Partial<DispatcherDeps> = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const attempts = createTaskAttemptStore(db);
  const turns: { sessionKey: string; content: string }[] = [];
  const pending = new Map<string, (info?: TurnEndInfo) => void>();

  const deps: DispatcherDeps = {
    svc,
    attempts,
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      const n = turns.length + 1;
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${n}`]);
      return { topicId: `topic-${n}`, sessionKey: `topic:sk${n}` };
    },
    createWorktree: async () => `wt-${turns.length + 1}`,
    deleteWorktree: async () => {},
    worktreeBranch: (id) => `task/${id}`,
    attemptStats: async () => ({ commit: "c0ffee", filesChanged: 1, insertions: 1, deletions: 0 }),
    archiveTopic: () => {},
    getLastAgentText: () => "riassunto",
    runTurn: (sessionKey, content) =>
      new Promise<TurnEndInfo | void>((res) => { turns.push({ sessionKey, content }); pending.set(sessionKey, res); }),
    broadcast: () => {},
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
    ...overrides,
  };
  const dispatcher = createTaskDispatcher(deps);
  return {
    db, svc, dispatcher, turns,
    task: (id: string) => svc.get(id)?.task,
    comments: (id: string) => (svc.get(id)?.comments ?? []).map((c) => c.content),
    started: () => (["heavy", "l1", "l2"] as const).filter((id) => svc.get(id)?.task.status === "in_progress"),
  };
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

/** Board accesa, worktree on, tetto largo: quello che si misura è il freno. */
function board(h: ReturnType<typeof harness>) {
  h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchFanOut: 1 });
  h.svc.setGlobalCap({ auto: false, max: 9 });
}

/**
 * La coda della notte del 12/08: un PESANTE con priorità alta in testa, due
 * leggeri dietro. `.sort` mette il pesante primo (priorità 4 > 2), quindi è lui
 * a incontrare il gate per primo.
 */
function codaConPesanteInTesta(h: ReturnType<typeof harness>) {
  seedTask(h.db, { id: "heavy", priority: 4, weight: "heavy" });
  seedTask(h.db, { id: "l1", priority: 2 });
  seedTask(h.db, { id: "l2", priority: 2 });
}

describe("freno del peso — quale carico guarda", () => {
  it("carico ESTERNO alto e agenti quasi fermi: i leggeri partono", async () => {
    // Le cifre sono quelle misurate: 12 core, load1 fra 37 e 48 (le app
    // dell'umano), e la nostra flotta a 75% su 1200% nella scala di `ps`, cioè
    // 0,75 core-unità. Le due misure differiscono di un fattore CINQUANTA sullo
    // stesso host e nello stesso istante: non sono due letture della stessa
    // cosa, e il guasto è stato usare la prima per rispondere alla seconda.
    const h = harness({
      capacity: () => ({ load1: 42, cores: 12 }),
      ownLoad: () => ({ coreUnits: 0.75, cores: 12 }),
    });
    board(h);
    codaConPesanteInTesta(h);

    // Primo giro. Il carico non è NOSTRO, quindi il freno non ha niente da
    // frenare e la testa della coda parte. Prima del fix il gate leggeva
    // 42 >= 12 → chiuso → `break` sul PRIMO elemento → zero partenze, e la
    // board restava lì (misurato: due in_progress col tetto a 9, per ore).
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.started()).toContain("heavy");

    // Il pesante finisce. Che tenga la macchina da solo mentre gira è la regola
    // del peso e resta in piedi: quello che il guasto impediva non era la
    // serializzazione, era che la fila si muovesse affatto.
    //
    // La riga si muove in SQL e non con un turno vero: qui si misura il freno,
    // non la chiusura di un turno, e `hasHeavyInFlight` legge esattamente questi
    // due campi (`server/services/tasks.ts`).
    h.db.run("UPDATE tasks SET status = 'done', dispatch_state = NULL WHERE id = 'heavy'");

    await h.dispatcher.tick(PID);
    await flush();

    // Ed ecco i leggeri. Prima del fix questa riga non arrivava mai: il pesante
    // in testa non partiva, quindi non finiva, quindi non liberava nessuno.
    expect(h.started()).toContain("l1");
    expect(h.started()).toContain("l2");
  });

  it("il carico NOSTRO alto trattiene ancora il pesante (il freno non è stato tolto)", async () => {
    // Il contro-esempio: stessa macchina, ma stavolta sono i nostri agenti a
    // occuparla. Il gate DEVE chiudersi, altrimenti il fix ha solo spento la
    // guardia invece di puntarla sul bersaglio giusto.
    const h = harness({
      capacity: () => ({ load1: 42, cores: 12 }),
      ownLoad: () => ({ coreUnits: 11, cores: 12 }),
    });
    board(h);
    codaConPesanteInTesta(h);

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.started()).toEqual([]);
    expect(h.task("heavy")!.dispatchState).toBe("queued");
  });

  it("sonda della flotta fredda: si ripiega sul load di sistema, non su «via libera»", async () => {
    // `fleetLoadSync` torna `null` finché la prima misura non è pronta (spawna
    // uno `ps`, e il tick non può aspettarlo). In quella finestra il freno deve
    // valere il vecchio comportamento, non sparire: senza sapere cosa c'è sulla
    // macchina, far partire un pesante accanto agli altri è la scelta peggiore.
    const h = harness({
      capacity: () => ({ load1: 42, cores: 12 }),
      ownLoad: () => null,
    });
    board(h);
    codaConPesanteInTesta(h);

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.started()).toEqual([]);
    // E la nota parla di load, non di core nostri: dice la misura che ha usato.
    expect(h.comments("heavy").join("\n")).toContain("load 42.0");
  });
});

describe("freno del peso — l'attesa ha una fine", () => {
  it("un pesante trattenuto oltre il tetto non tiene più ferma la coda", async () => {
    let now = Date.UTC(2026, 7, 12, 22, 0, 0);
    const h = harness({
      capacity: () => ({ load1: 42, cores: 12 }),
      // Carico NOSTRO alto per davvero: il gate è legittimamente chiuso, quindi
      // l'unica cosa che può sbloccare la coda è la scadenza dell'attesa.
      ownLoad: () => ({ coreUnits: 11, cores: 12 }),
      now: () => now,
    });
    board(h);
    codaConPesanteInTesta(h);

    // Primo giro: il freno morde, e va bene così. Zero partenze.
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.started()).toEqual([]);

    // Passano venti minuti di attesa vera.
    now += 20 * 60_000;
    await h.dispatcher.tick(PID);
    await flush();

    // Oltre il tetto la coda riparte: è il guasto misurato — due `in_progress`
    // col tetto a 9 per ORE, perché nessuno aveva messo una scadenza a
    // quell'attesa. Prima del fix questa riga trovava ancora la lista vuota.
    expect(h.started().length).toBeGreaterThan(0);
    // E lo si legge nel thread, invece di indovinarlo da una board ferma.
    expect(h.comments("heavy").join("\n")).toContain("20 min");
  });

  it("e lo dice anche la CARD, non solo il thread", async () => {
    // Il thread lo legge chi apre il task. Chi guarda la board vede il chip, e
    // il chip diceva «in coda» pure alla riga che teneva ferme tutte le altre.
    // Qui si chiude il giro riga → card: il chip `queued` su un task pesante È
    // la condizione, e `rowToTask` la traduce in una ragione che lo dichiara.
    const h = harness({
      capacity: () => ({ load1: 42, cores: 12 }),
      ownLoad: () => ({ coreUnits: 11, cores: 12 }),
    });
    board(h);
    codaConPesanteInTesta(h);

    await h.dispatcher.tick(PID);
    await flush();

    const r = h.task("heavy")!.queueReason!;
    expect(r.kind).toBe("heavy_hold");
    expect(r.detail).toContain("2 dietro");
    // I leggeri dietro NON sono il tappo: la loro ragione resta la fila.
    expect(h.task("l1")!.queueReason!.kind).toBe("slot");
  });

  it("aspettare un ALTRO pesante non consuma il tetto dell'attesa sul carico", async () => {
    // Due attese diverse che il tetto non deve confondere. «Aspetto che finisca
    // il pesante in volo» dura quanto dura quel turno ed è una regola sana;
    // «aspetto che la macchina si liberi» è quella che poteva non finire mai.
    // Contando la prima nella seconda, il pesante successivo uscirebbe dal
    // blocco gia' scaduto e partirebbe senza aver mai guardato il carico.
    let now = Date.UTC(2026, 7, 12, 22, 0, 0);
    const h = harness({
      capacity: () => ({ load1: 42, cores: 12 }),
      ownLoad: () => ({ coreUnits: 11, cores: 12 }),
      now: () => now,
    });
    board(h);
    // Un pesante gia' al lavoro, e un secondo pesante in coda dietro di lui.
    h.db.run("INSERT OR IGNORE INTO topics (id) VALUES ('topic-x')");
    h.db.run(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority, dispatch_weight, dispatch_state, assigned_topic_id)
       VALUES ('inflight', ?, 'gia in volo', 'in_progress', '2026-08-12T21:00:00.000Z', '2026-08-12T21:00:00.000Z', 0, 4, 'heavy', 'working', 'topic-x')`,
      [PID],
    );
    seedTask(h.db, { id: "heavy", priority: 4, weight: "heavy" });

    // Mezz'ora di turno del primo: ben oltre il tetto dell'attesa sul carico.
    await h.dispatcher.tick(PID);
    await flush();
    now += 30 * 60_000;
    await h.dispatcher.tick(PID);
    await flush();

    // Il primo finisce. Il secondo NON deve risultare gia' scaduto: la macchina
    // e' ancora occupata da noi, quindi tocca al freno del carico, da capo.
    h.db.run("UPDATE tasks SET status = 'done', dispatch_state = NULL WHERE id = 'inflight'");
    await h.dispatcher.tick(PID);
    await flush();

    expect(h.task("heavy")!.status).toBe("todo");
    expect(h.task("heavy")!.dispatchState).toBe("queued");
  });

  it("la nota dice che è LUI a tenere ferma la coda, non solo «in coda»", async () => {
    const h = harness({
      capacity: () => ({ load1: 42, cores: 12 }),
      ownLoad: () => ({ coreUnits: 11, cores: 12 }),
    });
    board(h);
    codaConPesanteInTesta(h);

    await h.dispatcher.tick(PID);
    await flush();

    // Due leggeri dietro di lui che non partiranno finché non parte lui: la
    // card deve dirlo. «In coda» da solo lascia credere che la fila scorra.
    const nota = h.comments("heavy").join("\n");
    expect(nota).toContain("2 task");
    expect(nota.toLowerCase()).toContain("coda");
  });

  it("un pesante in coda dietro un ALTRO pesante in volo NON è il tappo", async () => {
    // Il caso più comune, e quello in cui la card mentiva peggio di quando
    // diceva soltanto «in coda». Il chip `queued` su un pesante ha DUE
    // scritture, non una: il ramo del carico, e il ramo `heavyBusy` — che gira
    // su OGNI todo ed esce PRIMA del ciclo, quindi l'ordine della coda non
    // c'entra niente. Letto dal solo chip, il secondo caso si travestiva da
    // primo, e la card affermava quattro cose false in fila: che tiene la testa
    // della coda (no: il `return` su heavyBusy ignora l'ordine), che aspetta
    // margine di macchina (qui il margine c'è tutto), che parte entro il tetto
    // (a QUESTA attesa il tetto non si applica, per scelta esplicita), e che
    // abbassargli la priorità sbloccherebbe la fila (non sblocca nulla).
    const h = harness({
      // Macchina LIBERA: il freno del carico è fuori discussione, l'unica cosa
      // che tiene ferma la board è il pesante che sta già girando.
      capacity: () => ({ load1: 0.1, cores: 12 }),
      ownLoad: () => ({ coreUnits: 0.1, cores: 12 }),
    });
    board(h);
    h.db.run("INSERT OR IGNORE INTO topics (id) VALUES ('topic-x')");
    h.db.run(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority, dispatch_weight, dispatch_state, assigned_topic_id)
       VALUES ('inflight', ?, 'gia in volo', 'in_progress', '2026-08-12T21:00:00.000Z', '2026-08-12T21:00:00.000Z', 0, 4, 'heavy', 'working', 'topic-x')`,
      [PID],
    );
    codaConPesanteInTesta(h);

    await h.dispatcher.tick(PID);
    await flush();

    // Il chip `queued` c'è (il ramo heavyBusy lo scrive su tutti), e la nota
    // del thread è giusta com'è: dice che c'è un pesante al lavoro.
    expect(h.task("heavy")!.dispatchState).toBe("queued");
    expect(h.comments("heavy").join("\n")).toContain("PESANTE al lavoro");

    // Ma la CARD non deve accusare questa riga di tenere ferma la coda.
    const r = h.task("heavy")!.queueReason!;
    expect(r.kind).not.toBe("heavy_hold");
    expect(r.title).not.toContain("tetto");
    expect(r.title).not.toContain("priorità");
    // La riparazione si fermava qui: tolta la bugia, la card restava MUTA —
    // ricadeva su «in coda, N davanti», cioè la parola vaga da cui si era
    // partiti. Ed era vaga anche per i leggeri dietro: uno slot agente c'è
    // eccome (macchina libera, tetto lontano), quello che manca è la fine di un
    // turno altrui. Adesso i due casi hanno due parole, e quella dei leggeri
    // dice il fatto giusto.
    expect(r.kind).toBe("heavy_busy");
    expect(h.task("l1")!.queueReason!.kind).toBe("heavy_busy");
    expect(h.task("l1")!.queueReason!.detail).not.toContain("davanti");
  });
});
