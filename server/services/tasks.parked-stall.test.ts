/**
 * LO STALLO DEI SOTTOTASK PARCHEGGIATI È UNA DOMANDA, NON UN BLOCCO.
 *
 * Il guasto misurato il 12/08/2026: cinque card ferme e nessuna lo diceva. Il
 * figlio in backlog non lo prende nessun dispatcher, il padre che lo aspetta
 * veniva fermato per non girare a vuoto, e finiva PARCHEGGIATO IN BACKLOG con la
 * spiegazione dentro `dispatch_error` — cioè nel drawer di una card in fondo alla
 * colonna dove «ferma» è l'aspetto normale. Nessuno dei due pezzi era sbagliato
 * da solo; insieme erano un vicolo cieco che si apriva solo a mano.
 *
 * Qui si prova l'altra strada: la card va in REVIEW con le due risposte, e ognuna
 * delle due rimette il padre in coda senza toccare nient'altro.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, effort TEXT)`);
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'todo', priority INTEGER NOT NULL DEFAULT 2,
    kanban_order INTEGER NOT NULL DEFAULT 0, assigned_to TEXT, due_date TEXT, chat_id TEXT,
    created_at TEXT NOT NULL, completed_at TEXT, updated_at TEXT NOT NULL,
    claude_task_id TEXT, assigned_topic_id TEXT REFERENCES topics(id), assigned_agent_id TEXT,
    archived INTEGER NOT NULL DEFAULT 0, in_progress_at TEXT,
    dispatch_attempts INTEGER NOT NULL DEFAULT 0, dispatch_state TEXT, dispatch_error TEXT,
    dispatch_deferred_until TEXT, dispatch_weight TEXT,
    parent_task_id TEXT REFERENCES tasks(id), plan_first INTEGER NOT NULL DEFAULT 0,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    agent_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    priority_auto INTEGER NOT NULL DEFAULT 1, reuse_blocker_context INTEGER NOT NULL DEFAULT 0,
    wait_streak INTEGER NOT NULL DEFAULT 0, wait_reason TEXT, wait_since TEXT,
    blocked_by_task_id TEXT REFERENCES tasks(id), output_url TEXT, preview_image TEXT,
    preview_retired_at TEXT, preview_retired_reason TEXT,
    checks_state TEXT, checks_at TEXT, checks_commit TEXT, checks_json TEXT,
    delivery_branch TEXT, delivery_commit TEXT, landing_state TEXT, landing_checked_at TEXT,
    landing_witnessed INTEGER NOT NULL DEFAULT 0,
    delivered_by TEXT, delivered_reason TEXT,
    done_actor TEXT, reopened_at TEXT, reopened_by TEXT, reopened_actor TEXT,
    model TEXT, created_by_topic_id TEXT,
    -- Le colonne del 16/08, in fondo come le mette ALTER TABLE in produzione:
    -- l'entita' della consegna (20260816174500) e da quando la card aspetta
    -- una risposta umana (20260816214500). Questo DDL e' una copia a mano e
    -- non lo stub condiviso, quindi ogni migration nuova va ripetuta QUI o
    -- ogni test del file muore su "no such column" - che e' precisamente cio'
    -- che e' successo aggiungendo review_at.
    delivery_files_changed INTEGER, delivery_insertions INTEGER, delivery_deletions INTEGER,
    review_at TEXT
  )`);
  // See the note in tasks.queue-reason.test.ts: `readGlobalCap` SELECTs
  // `max_agents_auto`, so leaving it out of this DDL arms a "no such column"
  // throw for the first test here that touches the machine-wide cap.
  // migration 20260816112635: l'interruttore GLOBALE dell'auto-dispatch vive in
  // `app_settings`, non piu' sulla riga '*' di `board_settings`.
  db.run(`CREATE TABLE IF NOT EXISTS app_settings (id INTEGER PRIMARY KEY CHECK (id = 1), auto_dispatch INTEGER)`);
  db.run(`INSERT OR IGNORE INTO app_settings (id, auto_dispatch) VALUES (1, 0)`);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, auto_dispatch INTEGER NOT NULL DEFAULT 0,
    max_agents INTEGER DEFAULT 3, max_agents_auto INTEGER, dispatch_retry_cap INTEGER
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  db.run(`CREATE TABLE task_labels (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'human',
    created_at TEXT NOT NULL, PRIMARY KEY (task_id, label)
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  // L'interruttore globale sta in `app_settings` dalla migration 20260816112635:
  // sulla riga '*' di board_settings la colonna non esiste piu'.
  db.run("UPDATE app_settings SET auto_dispatch = 1");
  return db;
}

const PID = "topics-app-abc123";

let clock = 0;
function svc(db: Database): TaskService {
  let n = 0;
  return createTaskService(db, {
    now: () => new Date(Date.UTC(2026, 7, 12, 9, clock++)).toISOString(),
    uuid: () => `id-${++n}`,
    // Due domande identiche a distanza di un minuto NON sono un doppione da
    // sopprimere in questi test: la finestra di dedupe si azzera apposta.
    commentDedupeMs: 0,
  });
}

/** Il padre col figlio parcheggiato, nella forma esatta in cui è stato misurato. */
function padreConFiglioParcheggiato(s: TaskService): { padre: string; figlio: string } {
  const padre = s.create({ projectId: PID, text: "Il padre", status: "in_progress" });
  const figlio = s.create({ projectId: PID, text: "Il sottotask rimandato", parentTaskId: padre.id });
  return { padre: padre.id, figlio: figlio.id };
}

/** `archived` non viaggia sul Task: si legge dove sta, sulla riga. */
const archiviato = (db: Database, id: string) =>
  (db.prepare("SELECT archived FROM tasks WHERE id = ?").get(id) as { archived: number }).archived;

const ultimoCommento = (s: TaskService, id: string) => {
  const c = s.get(id)!.comments.filter((x) => x.kind !== "status");
  return c[c.length - 1]!.content;
};

describe("l'anello: rimettere in coda una seconda volta non si offre piu'", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { clock = 0; db = freshDb(); s = svc(db); });

  /** La domanda con le sue due risposte, come la legge il client. */
  const opzioni = (id: string) => {
    const c = s.get(id)!.comments.filter((x) => x.kind !== "status");
    const testo = c[c.length - 1]!.content;
    return testo.split("\n").filter((r) => r.startsWith("- ")).map((r) => r.slice(2).trim());
  };

  test("la PRIMA volta offre di rimettere in coda", () => {
    const { padre } = padreConFiglioParcheggiato(s);
    s.deliverToReviewBySystem({ taskId: padre, reason: "turno finito" });
    expect(opzioni(padre)).toEqual(["Rimetti in coda i sottotask", "Archivia i sottotask"]);
  });

  test("la SECONDA volta no: quella strada si e' gia' dimostrata circolare", () => {
    // L'anello misurato: «rimetti in coda» porta i figli in `todo`, ma un figlio
    // in `todo` conta fermo lo stesso (il tick lista `rootsOnly`), quindi la
    // domanda torna identica e chi risponde ripreme lo stesso bottone. Offrire
    // due volte un'uscita circolare non e' dare una scelta.
    //
    // LA SONDA GUARDAVA IL POSTO SBAGLIATO, e questo test lo nascondeva: il
    // conto era `content = REQUEUE_PARKED_LABEL`, e nessuna porta scrive mai un
    // commento il cui corpo INTERO sia l'etichetta del bottone. Il test lo
    // scriveva a mano — quella riga qui sotto non c'è più — quindi provava che
    // la logica funzionava DATO un fatto che in produzione non esisteva: il
    // conto restava zero, la terza uscita non compariva mai, e chi rispondeva si
    // ritrovava lo stesso bottone circolare. Adesso si conta la nota che
    // `resolveParkedChildren` scrive davvero.
    const { padre } = padreConFiglioParcheggiato(s);
    s.deliverToReviewBySystem({ taskId: padre, reason: "turno finito" });
    s.resolveParkedChildren({ taskId: padre, decision: "requeue", by: "attilio" });
    // Il turno riparte e finisce di nuovo senza toccare gli step.
    s.update({ taskId: padre, actor: "human", by: "attilio", patch: { status: "in_progress" } });
    s.deliverToReviewBySystem({ taskId: padre, reason: "turno finito" });

    const o = opzioni(padre);
    expect(o).not.toContain("Rimetti in coda i sottotask");
    expect(o).toContain("Archivia i sottotask");
    expect(o).toContain("La prendo in mano io");
    // E lo DICE, invece di ripetere la stessa frase come se fosse la prima volta.
    const testo = s.get(padre)!.comments.filter((x) => x.kind !== "status").at(-1)!.content;
    expect(testo).toContain("l'ha gia' fatto");
  });
});

describe("un padre fermo solo su figli parcheggiati fa una DOMANDA", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { clock = 0; db = freshDb(); s = svc(db); });

  test("il turno finito porta il padre in review con le due risposte, non in backlog", () => {
    const { padre } = padreConFiglioParcheggiato(s);
    const t = s.deliverToReviewBySystem({ taskId: padre, reason: "tentativi esauriti" });

    expect(t.status).toBe("review");
    expect(t.dispatchState).toBe("needs_input");
    expect(t.deliveredBy).toBe("system");
    expect(t.deliveredReason).toBe("parked_children");
    // Le due risposte, nel blocco che il client rende come bottoni.
    const testo = ultimoCommento(s, padre);
    expect(testo).toContain("```question");
    expect(testo).toContain("- Rimetti in coda i sottotask");
    expect(testo).toContain("- Archivia i sottotask");
    expect(testo).toContain("Il sottotask rimandato");
  });

  test("un figlio IN VOLO non è uno stallo: il padre torna in coda ad aspettare", () => {
    const padre = s.create({ projectId: PID, text: "Il padre", status: "in_progress" }).id;
    const figlio = s.create({ projectId: PID, text: "Un figlio vivo", parentTaskId: padre }).id;
    s.update({ taskId: figlio, actor: "human", by: "attilio", patch: { status: "in_progress" } });

    const t = s.deliverToReviewBySystem({ taskId: padre, reason: "tentativi esauriti" });
    expect(t.status).toBe("todo");
    expect(t.dispatchState).toBe("waiting");
    expect(t.deliveredReason).not.toBe("parked_children");
  });

  // IL GUASTO DEL 13/08, nella riga in cui è nato. Sette padri e ventuno card
  // ferme sotto la soglia: il figlio stava in `todo`, cioè nella colonna che si
  // legge «in coda», e il padre lo aspettava come se qualcuno dovesse
  // prenderlo. Nessuno lo prende — il tick lista `rootsOnly` — e il padre
  // rientrava in coda ogni dieci minuti per sempre, senza dirlo a nessuno.
  test("un figlio fermo in TODO è fermo quanto uno in backlog: il padre CHIEDE", () => {
    const padre = s.create({ projectId: PID, text: "Il padre", status: "in_progress" }).id;
    const figlio = s.create({ projectId: PID, text: "Uno step lasciato in todo", parentTaskId: padre }).id;
    // Il turno del padre è ancora vivo, quindi lo step lasciato in todo per ora
    // è solo una riga nel thread: qui si prova la FINE del turno.
    s.update({ taskId: figlio, actor: "agent", by: "agent", patch: { status: "todo" } });
    expect(s.get(padre)!.task.status).toBe("in_progress");

    const t = s.deliverToReviewBySystem({ taskId: padre, reason: "tentativi esauriti" });
    expect(t.status).toBe("review");
    expect(t.dispatchState).toBe("needs_input");
    expect(t.deliveredReason).toBe("parked_children");
    expect(ultimoCommento(s, padre)).toContain("Uno step lasciato in todo");
  });

  // Lo specchio del precedente: un figlio in `todo` col PROPRIO chip addosso si
  // muove da sé, e il padre non deve chiedere niente. È la riga che impedisce a
  // «todo = fermo» di diventare «todo = sempre uno stallo».
  test("un figlio in todo col chip di dispatch addosso è in volo, e il padre tace", () => {
    const padre = s.create({ projectId: PID, text: "Il padre", status: "in_progress" }).id;
    const figlio = s.create({ projectId: PID, text: "Uno step reclamato", parentTaskId: padre }).id;
    s.update({ taskId: figlio, actor: "agent", by: "agent", patch: { status: "todo" } });
    s.setDispatchState({ taskId: figlio, state: "queued" });

    const t = s.deliverToReviewBySystem({ taskId: padre, reason: "tentativi esauriti" });
    expect(t.status).toBe("todo");
    expect(t.deliveredReason).not.toBe("parked_children");
  });

  test("la domanda non si ripete: due giri, una sola domanda", () => {
    const { padre } = padreConFiglioParcheggiato(s);
    s.deliverToReviewBySystem({ taskId: padre, reason: "primo giro" });
    expect(s.askParkedChildren({ taskId: padre })).toBeNull();
    const domande = s.get(padre)!.comments.filter((c) => c.content.includes("```question"));
    expect(domande).toHaveLength(1);
  });

  test("parcheggiare il figlio alza la domanda SUBITO, senza aspettare un turno", () => {
    // Il caso misurato: padre già fermo in backlog, figlio che ci finisce dopo.
    const padre = s.create({ projectId: PID, text: "Il padre fermo" }).id;
    const figlio = s.create({ projectId: PID, text: "Un figlio", parentTaskId: padre }).id;
    s.update({ taskId: figlio, actor: "human", by: "attilio", patch: { status: "in_progress" } });
    expect(s.get(padre)!.task.status).toBe("backlog");

    s.update({ taskId: figlio, actor: "human", by: "attilio", patch: { status: "backlog" } });

    const t = s.get(padre)!.task;
    expect(t.status).toBe("review");
    expect(t.dispatchState).toBe("needs_input");
    expect(ultimoCommento(s, padre)).toContain("- Rimetti in coda i sottotask");
  });

  test("l'agente che spunta il PRIMO passo della sua checklist non si taglia il turno", () => {
    // IL GUASTO DEL 18/08, nella sua forma esatta. Tre card dispacciate su
    // cinque sono finite in review al PRIMO turno, con zero commit e una
    // domanda di contabilita' in cima alla colonna: l'agente apriva la sua
    // checklist (i sottotask nascono in `backlog`), spuntava il primo passo, e
    // nel momento in cui quel figlio usciva dal volo `childLeftFlight` chiamava
    // `askParkedChildren` — che SPOSTA la card — mentre il turno era vivo.
    // La sessione di `e33820da` aveva due messaggi in tutto.
    //
    // `parkedChildRaisedStall` la guardia ce l'aveva (il test qui sopra);
    // `childLeftFlight` no, e la funzione che muove la card nemmeno. Adesso la
    // guardia sta dove si muove la card, cioe' in un posto solo.
    const TOPIC = "t-agente";
    db.prepare("INSERT INTO topics (id) VALUES (?)").run(TOPIC);
    const padre = s.create({ projectId: PID, text: "Il padre al lavoro", status: "in_progress" }).id;
    // Il legame topic<->card lo scrive il dispatcher: qui si mette sulla riga,
    // che e' quello che `isOwnStep` legge per riconoscere «uno step MIO».
    db.prepare("UPDATE tasks SET assigned_topic_id = ? WHERE id = ?").run(TOPIC, padre);
    const uno = s.create({ projectId: PID, text: "1. il primo passo", parentTaskId: padre }).id;
    s.create({ projectId: PID, text: "2. il secondo passo", parentTaskId: padre });
    s.create({ projectId: PID, text: "3. il terzo passo", parentTaskId: padre });
    s.update({ taskId: uno, actor: "agent", by: "agent", agentTopicId: TOPIC, patch: { status: "in_progress" } });

    // Spunta il primo passo — che l'agente PUO' chiudere: e' uno step suo.
    // L'ultimo figlio in volo esce, e ne restano due fermi.
    s.update({ taskId: uno, actor: "agent", by: "agent", agentTopicId: TOPIC, patch: { status: "done" } });

    const t = s.get(padre)!.task;
    expect(t.status, "il padre stava lavorando: la sua card non si sposta").toBe("in_progress");
    expect(t.dispatchState).not.toBe("needs_input");
    expect(t.deliveredReason).not.toBe("parked_children");
  });

  test("finito il turno la domanda si fa comunque: non si perde, si sposta", () => {
    // L'altra meta' della guardia. Se la domanda sparisse invece di spostarsi,
    // il padre resterebbe fermo per sempre su figli che nessuno prende — il
    // guasto del 12/08 che questo file esiste per chiudere.
    const padre = s.create({ projectId: PID, text: "Il padre", status: "in_progress" }).id;
    s.create({ projectId: PID, text: "Uno step mai lavorato", parentTaskId: padre });

    const out = s.askParkedChildren({ taskId: padre, by: "dispatcher", evenIfLive: true });

    expect(out, "chi chiude il turno sa che e' finito: la domanda si fa").not.toBeNull();
    expect(s.get(padre)!.task.status).toBe("review");
    expect(s.get(padre)!.task.dispatchState).toBe("needs_input");
  });

  test("se il padre STA LAVORANDO l'avviso è una riga nel thread, non un turno tagliato", () => {
    const padre = s.create({ projectId: PID, text: "Il padre al lavoro", status: "in_progress" }).id;
    const figlio = s.create({ projectId: PID, text: "Uno step", parentTaskId: padre }).id;
    s.update({ taskId: figlio, actor: "human", by: "attilio", patch: { status: "in_progress" } });

    s.update({ taskId: figlio, actor: "agent", by: "agent", patch: { status: "backlog" } });

    expect(s.get(padre)!.task.status).toBe("in_progress");
    expect(ultimoCommento(s, padre)).toContain("Sottotask fermo");
  });
});

/**
 * IL RASTRELLO. La domanda si arma su due EVENTI, e una card che si era fermata
 * prima non ne vedrà mai un altro: nessun turno tornerà lì a scoprirlo. È la
 * ragione per cui il 13/08 sette padri erano fermi da ore con la domanda mai
 * fatta — il codice per farla c'era già, non passava più nessuno a chiamarlo.
 */
describe("il rastrello arriva anche sulle card già ferme", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { clock = 0; db = freshDb(); s = svc(db); });

  test("un padre fermo da ieri, con lo step in todo, riceve la domanda al primo giro", () => {
    const padre = s.create({ projectId: PID, text: "Il padre di ieri" }).id;
    const figlio = s.create({ projectId: PID, text: "Lo step di ieri", parentTaskId: padre }).id;
    // Lo stallo com'è sul DB, senza passare dagli eventi: è esattamente la
    // situazione in cui nessuna porta del servizio verrà più attraversata.
    db.run("UPDATE tasks SET status = 'todo' WHERE id = ?", [figlio]);
    db.run("UPDATE tasks SET status = 'backlog', dispatch_state = 'stopped' WHERE id = ?", [padre]);

    const chiesti = s.sweepParkedChildren({ by: "dispatcher" });

    expect(chiesti.map((t) => t.id)).toEqual([padre]);
    const t = s.get(padre)!.task;
    expect(t.status).toBe("review");
    expect(t.deliveredReason).toBe("parked_children");
    expect(ultimoCommento(s, padre)).toContain("Lo step di ieri");
  });

  test("il secondo giro non ripete niente: la domanda è già sulla card", () => {
    const padre = s.create({ projectId: PID, text: "Il padre di ieri" }).id;
    s.create({ projectId: PID, text: "Lo step di ieri", parentTaskId: padre });

    expect(s.sweepParkedChildren()).toHaveLength(1);
    expect(s.sweepParkedChildren()).toHaveLength(0);
  });

  test("non rastrella chi ha un turno addosso, chi è in review e chi è dentro la finestra di rinvio", () => {
    const alLavoro = s.create({ projectId: PID, text: "Ha un turno", status: "in_progress" }).id;
    s.create({ projectId: PID, text: "Step 1", parentTaskId: alLavoro });
    const inArrivo = s.create({ projectId: PID, text: "Il turno parte al tick" }).id;
    s.create({ projectId: PID, text: "Step 2", parentTaskId: inArrivo });
    s.setDispatchState({ taskId: inArrivo, state: "queued" });
    const rinviato = s.create({ projectId: PID, text: "Riprende più tardi" }).id;
    s.create({ projectId: PID, text: "Step 3", parentTaskId: rinviato });
    db.run("UPDATE tasks SET dispatch_deferred_until = '2099-01-01T00:00:00.000Z' WHERE id = ?", [rinviato]);
    const inReview = s.create({ projectId: PID, text: "Consegnato", status: "review" }).id;
    s.create({ projectId: PID, text: "Step 4", parentTaskId: inReview });

    expect(s.sweepParkedChildren()).toEqual([]);
  });

  // L'ANELLO, misurato il 15/08 su `5505c6fa` — una card che di suo si intitola
  // «review che non rientra in coda». Rimessa in coda alle 20:32, di nuovo in
  // review alle 20:49, senza che nessun agente l'avesse toccata: chi rispondeva
  // vedeva la card tornare indietro da sola e la stessa domanda ricomparire.
  test("un padre appena rimesso in coda NON si rastrella: il suo turno deve ancora partire", () => {
    const padre = s.create({ projectId: PID, text: "Rimesso in coda ora" }).id;
    s.create({ projectId: PID, text: "Uno step fermo", parentTaskId: padre });
    // Esattamente cio' che scrive `update` quando un umano lo porta in Todo:
    // stato di dispatch azzerato, tentativi a zero.
    db.run(
      "UPDATE tasks SET status = 'todo', dispatch_state = NULL, dispatch_attempts = 0 WHERE id = ?",
      [padre],
    );

    expect(s.sweepParkedChildren()).toEqual([]);
    expect(s.get(padre)!.task.status).toBe("todo");
  });

  // …e il verso opposto, che e' quello che il rastrello esiste per prendere: un
  // turno l'ha gia' avuto, i figli non li ha toccati, e in `todo` non ci sta
  // aspettando niente.
  test("un padre in todo che un turno l'ha gia' speso viene rastrellato lo stesso", () => {
    const padre = s.create({ projectId: PID, text: "Un turno l'ha avuto" }).id;
    s.create({ projectId: PID, text: "Uno step fermo", parentTaskId: padre });
    db.run(
      "UPDATE tasks SET status = 'todo', dispatch_state = NULL, dispatch_attempts = 2 WHERE id = ?",
      [padre],
    );

    expect(s.sweepParkedChildren().map((t) => t.id)).toEqual([padre]);
    expect(s.get(padre)!.task.status).toBe("review");
  });

  // Una board SPENTA non si tocca da sola: nessuna coda scorre, quindi «rimetti
  // in coda» non farebbe partire niente, e una card che si muove dove qualcuno
  // ha spento la macchina è la sorpresa che toglie fiducia al chip.
  test("la board spenta resta com'è", () => {
    const padre = s.create({ projectId: PID, text: "Su una board spenta" }).id;
    s.create({ projectId: PID, text: "Uno step", parentTaskId: padre });

    expect(s.sweepParkedChildren({ eligible: () => false })).toEqual([]);
    expect(s.get(padre)!.task.status).toBe("backlog");
    expect(s.sweepParkedChildren({ eligible: (pid) => pid === PID })).toHaveLength(1);
  });
});

describe("le due risposte, e cosa fanno davvero", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { clock = 0; db = freshDb(); s = svc(db); });

  test("«rimetti in coda»: i figli in todo, il padre in coda col chip queued", () => {
    const { padre, figlio } = padreConFiglioParcheggiato(s);
    s.deliverToReviewBySystem({ taskId: padre, reason: "tentativi esauriti" });

    const esito = s.resolveParkedChildren({ taskId: padre, decision: "requeue", by: "attilio" })!;
    expect(esito.children.map((c) => c.status)).toEqual(["todo"]);
    expect(s.get(figlio)!.task.status).toBe("todo");
    expect(esito.task.status).toBe("todo");
    expect(esito.task.dispatchState).toBe("queued");
    // Mandato nuovo = budget nuovo: senza, il padre tornerebbe in una coda che
    // non lo serve più.
    expect(esito.task.dispatchAttempts).toBe(0);
    // «senza toccare altro»: il figlio non è archiviato, il padre non è chiuso.
    expect(archiviato(db, figlio)).toBe(0);
  });

  test("«archivia»: i figli spariscono e il padre riparte da solo", () => {
    const { padre } = padreConFiglioParcheggiato(s);
    s.deliverToReviewBySystem({ taskId: padre, reason: "tentativi esauriti" });

    const { figlio } = { figlio: s.get(padre)!.children[0]!.id };
    const esito = s.resolveParkedChildren({ taskId: padre, decision: "archive", by: "attilio" })!;
    expect(esito.children).toHaveLength(1);
    expect(archiviato(db, figlio)).toBe(1);
    expect(esito.task.status).toBe("todo");
    expect(esito.task.dispatchState).toBe("queued");
    // E ora è chiudibile: era l'unica cosa che glielo impediva.
    const chiuso = s.update({ taskId: padre, actor: "human", by: "attilio", patch: { status: "done" } });
    expect(chiuso.status).toBe("done");
  });

  test("rispondere due volte non inventa un secondo esito", () => {
    const { padre } = padreConFiglioParcheggiato(s);
    s.deliverToReviewBySystem({ taskId: padre, reason: "tentativi esauriti" });
    expect(s.resolveParkedChildren({ taskId: padre, decision: "requeue", by: "attilio" })).not.toBeNull();
    expect(s.resolveParkedChildren({ taskId: padre, decision: "requeue", by: "attilio" })).toBeNull();
  });

  test("la risposta chiude l'approvazione pendente: il task non è più in review", () => {
    const { padre } = padreConFiglioParcheggiato(s);
    s.deliverToReviewBySystem({ taskId: padre, reason: "tentativi esauriti" });
    s.resolveParkedChildren({ taskId: padre, decision: "requeue", by: "attilio" });
    const r = db.prepare("SELECT status FROM approvals WHERE task_id = ?").get(padre) as { status: string };
    expect(r.status).toBe("expired");
  });
});

/**
 * IL VERSO OPPOSTO. Fin qui si guardava il padre quando un figlio ENTRA in
 * backlog. Nessuno lo guardava quando un figlio ne ESCE per sempre, e il 13/08
 * `probe:stalls` ha misurato il conto: tre padri fermi, due dei quali consegne
 * vere dell'agente dell'11/08 che portavano ancora addosso il chip «in attesa»
 * dei figli e una finestra di rinvio scaduta da due giorni. Chiudere l'ultimo
 * figlio non ridava un turno a nessuno.
 */
describe("chiudere l'ultimo figlio rimette in moto il padre", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { clock = 0; db = freshDb(); s = svc(db); });

  /** Il padre parcheggiato ad aspettare i figli, come lo lascia il turno finito. */
  function padreInAttesa(figli: number): { padre: string; figli: string[] } {
    const padre = s.create({ projectId: PID, text: "Il padre", status: "in_progress" }).id;
    const ids = Array.from({ length: figli }, (_, i) => {
      const f = s.create({ projectId: PID, text: `Step ${i + 1}`, parentTaskId: padre }).id;
      // `in_progress`, non `todo`. Da quando uno step lasciato in TODO conta come
      // fermo quanto uno in backlog (il tick lista `rootsOnly`, quindi nessuno lo
      // prenderebbe mai), un figlio in todo fa CHIEDERE il padre: arriverebbe qui
      // con `needs_input`, e questi casi parlano invece del padre che ASPETTA
      // figli davvero in volo. Sono due situazioni diverse, e serve la seconda.
      s.update({ taskId: f, actor: "human", by: "attilio", patch: { status: "in_progress" } });
      return f;
    });
    // Il turno finisce coi figli aperti: in volo + chip `waiting` + finestra.
    s.deliverToReviewBySystem({ taskId: padre, reason: "turno finito" });
    return { padre, figli: ids };
  }

  const riga = (id: string) => db.prepare(
    "SELECT status, dispatch_state, dispatch_deferred_until FROM tasks WHERE id = ?",
  ).get(id) as { status: string; dispatch_state: string | null; dispatch_deferred_until: string | null };

  test("checklist finita: la finestra di rinvio sparisce e il tick lo riprende subito", () => {
    const { padre, figli } = padreInAttesa(1);
    expect(riga(padre).dispatch_state).toBe("waiting");
    expect(riga(padre).dispatch_deferred_until).not.toBeNull();

    s.update({ taskId: figli[0]!, actor: "human", by: "attilio", patch: { status: "done" } });

    const p = riga(padre);
    expect(p.status).toBe("todo");
    expect(p.dispatch_state).toBeNull();
    expect(p.dispatch_deferred_until).toBeNull();
  });

  test("finché UN figlio è ancora in volo non si tocca niente", () => {
    const { padre, figli } = padreInAttesa(2);
    s.update({ taskId: figli[0]!, actor: "human", by: "attilio", patch: { status: "done" } });
    expect(riga(padre).dispatch_state).toBe("waiting");
    expect(riga(padre).dispatch_deferred_until).not.toBeNull();
  });

  test("il padre in review non si muove, ma perde il chip che parla di figli che non ci sono più", () => {
    // La forma esatta di f9250521 ed e285d5d8: consegna vera dell'agente, chip
    // `waiting` stantio addosso, figli in review.
    const { padre, figli } = padreInAttesa(1);
    db.run("UPDATE tasks SET status = 'review', delivered_by = 'agent' WHERE id = ?", [padre]);
    s.update({ taskId: figli[0]!, actor: "human", by: "attilio", patch: { status: "review" } });
    s.update({ taskId: figli[0]!, actor: "human", by: "attilio", patch: { status: "done" } });

    const p = riga(padre);
    expect(p.status).toBe("review");
    expect(p.dispatch_state).toBeNull();
    // La consegna resta dell'agente: non è diventata una consegna di sistema.
    expect(s.get(padre)!.task.deliveredBy).toBe("agent");
    // Ed è finalmente approvabile, che era l'unica cosa che serviva.
    expect(s.reviewDecision({ taskId: padre, by: "attilio", decision: "approve" }).status).toBe("done");
  });

  test("restano solo parcheggiati e il padre è libero: parte la domanda coi due bottoni", () => {
    const padre = s.create({ projectId: PID, text: "Il padre", status: "in_progress" }).id;
    const vivo = s.create({ projectId: PID, text: "Lo step vivo", parentTaskId: padre }).id;
    s.create({ projectId: PID, text: "Lo step rimandato", parentTaskId: padre });
    s.update({ taskId: vivo, actor: "human", by: "attilio", patch: { status: "todo" } });
    s.deliverToReviewBySystem({ taskId: padre, reason: "turno finito" });

    s.update({ taskId: vivo, actor: "human", by: "attilio", patch: { status: "done" } });

    const t = s.get(padre)!.task;
    expect(t.status).toBe("review");
    expect(t.deliveredReason).toBe("parked_children");
    expect(ultimoCommento(s, padre)).toContain("- Rimetti in coda i sottotask");
  });

  test("padre GIÀ in review con una consegna vera: la domanda si posa nel thread e la consegna resta sua", () => {
    const padre = s.create({ projectId: PID, text: "Il padre", status: "in_progress" }).id;
    const vivo = s.create({ projectId: PID, text: "Lo step vivo", parentTaskId: padre }).id;
    s.create({ projectId: PID, text: "Lo step rimandato", parentTaskId: padre });
    s.update({ taskId: vivo, actor: "human", by: "attilio", patch: { status: "todo" } });
    db.run("UPDATE tasks SET status = 'review', delivered_by = 'agent' WHERE id = ?", [padre]);

    s.update({ taskId: vivo, actor: "human", by: "attilio", patch: { status: "done" } });

    const t = s.get(padre)!.task;
    expect(t.status).toBe("review");
    expect(t.deliveredBy).toBe("agent");
    expect(t.deliveredReason).toBeNull();
    expect(ultimoCommento(s, padre)).toContain("- Archivia i sottotask");
  });

  test("la domanda nel thread non si ripete a ogni figlio che chiude", () => {
    const padre = s.create({ projectId: PID, text: "Il padre", status: "in_progress" }).id;
    const a = s.create({ projectId: PID, text: "Step A", parentTaskId: padre }).id;
    const b = s.create({ projectId: PID, text: "Step B", parentTaskId: padre }).id;
    s.create({ projectId: PID, text: "Lo step rimandato", parentTaskId: padre });
    for (const f of [a, b]) s.update({ taskId: f, actor: "human", by: "attilio", patch: { status: "todo" } });
    db.run("UPDATE tasks SET status = 'review', delivered_by = 'agent' WHERE id = ?", [padre]);

    s.update({ taskId: a, actor: "human", by: "attilio", patch: { status: "done" } });
    s.update({ taskId: b, actor: "human", by: "attilio", patch: { status: "done" } });

    const domande = s.get(padre)!.comments.filter((c) => c.content.includes("```question"));
    expect(domande).toHaveLength(1);
  });

  test("archiviare l'ultimo figlio conta quanto chiuderlo", () => {
    const { padre, figli } = padreInAttesa(1);
    s.archive({ taskId: figli[0]! });
    const p = riga(padre);
    expect(p.dispatch_state).toBeNull();
    expect(p.dispatch_deferred_until).toBeNull();
  });

  test("un padre archiviato o chiuso non si tocca", () => {
    const { padre, figli } = padreInAttesa(1);
    db.run("UPDATE tasks SET archived = 1 WHERE id = ?", [padre]);
    s.update({ taskId: figli[0]!, actor: "human", by: "attilio", patch: { status: "done" } });
    expect(riga(padre).dispatch_state).toBe("waiting");
  });
});
