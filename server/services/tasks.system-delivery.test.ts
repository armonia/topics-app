/**
 * LE PORTE DI SISTEMA NON SCAVALCANO I CANCELLI DI REVIEW.
 *
 * Misurato il 18/08 su `bb9fdc41`: la card era in review con tre file non
 * committati nel worktree e zero commit propri sul ramo. La riga di stato
 * diceva `dispatcher | in_progress->review` -- era la consegna forzata, non
 * l'agente. Il land si rifiutava (riportare main dentro il ramo avrebbe
 * inglobato i file sporchi nella fusione) e la card restava ferma finche'
 * qualcuno non puliva a mano.
 *
 * I due predicati del gate di consegna -- `review_needs_summary` (l'agente
 * deve aver scritto qualcosa) e `review_needs_commit` (il diff deve essere
 * leggibile dalla card) -- scattavano solo dentro `update()` con
 * `actor === 'agent'`. Le porte di sistema (`deliverToReviewBySystem` e
 * `askParkedChildren`) scrivevano `status = 'review'` con una UPDATE grezza
 * senza passare di li'.
 *
 * Il cancello per le porte di sistema NON PUO' NEGARE: il turno e' finito,
 * la card deve andare da qualche parte. Ma puo' DIRE. Questi test verificano
 * che il fatto sia leggibile sulla card prima che qualcuno clicchi "Landa".
 *
 * -- NOTA SU review_needs_commit --
 * Il predicato richiede accesso a git (worktree dirt probe), che non esiste
 * al livello del servizio. L'annotazione per quella condizione arriva
 * dall'esterno: `captureDelivery` (dispatcher) scrive `delivery_files_changed`
 * prima di chiamare `deliverToReviewBySystem`, e quando quel campo e' zero
 * `reviewEvidence()` risponde `kind: 'uncommitted'` -- il chip sulla card.
 * Il test (c) qui sotto verifica quella catena a livello di servizio.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { type Database } from "bun:sqlite";
import { freshDb } from "./tasks-test-db";
import { createTaskService, TaskServiceError } from "./tasks";
import { reviewEvidence } from "../../client/src/lib/reviewEvidence";

/** Aggiunge task_attempts al DB del banco condiviso (non e' nella DDL base). */
function withAttempts(db: Database): Database {
  db.run(`CREATE TABLE IF NOT EXISTS task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, topic_id TEXT, worktree_id TEXT, branch TEXT, model TEXT,
    state TEXT NOT NULL DEFAULT 'running', commit_sha TEXT, files_changed INTEGER,
    insertions INTEGER, deletions INTEGER, summary TEXT, error TEXT,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, ended_at TEXT, selected_at TEXT,
    UNIQUE (task_id, idx)
  )`);
  return db;
}

/** Crea un task e lo porta in_progress con un topic assegnato. */
function seedInProgress(db: Database, svc: ReturnType<typeof createTaskService>): string {
  const t = svc.create({ text: "feat", projectId: "pX" });
  db.run("INSERT INTO topics (id) VALUES ('t1') ON CONFLICT DO NOTHING");
  db.prepare(
    "UPDATE tasks SET status = 'in_progress', assigned_topic_id = 't1', dispatch_attempts = 1 WHERE id = ?",
  ).run(t.id);
  // Riga di stato per lastTurnStart (il gate legge l'evento in_progress piu' recente).
  db.prepare(
    "INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?,?,?,?,?,?)",
  ).run("st-1", t.id, "dispatcher", "in_progress->in_progress", "status", new Date().toISOString());
  return t.id;
}

// ── deliverToReviewBySystem ───────────────────────────────────────────────────

describe("deliverToReviewBySystem: porte di sistema annota review_needs_summary", () => {
  let db: Database;

  beforeEach(() => { db = withAttempts(freshDb()); });

  test("(a) turno MUTO: nota di servizio visibile nel thread", () => {
    // Nessun commento dell'agente: la consegna e' muta.
    const svc = createTaskService(db);
    const taskId = seedInProgress(db, svc);

    const t = svc.deliverToReviewBySystem({ taskId, reason: "turni esauriti" });

    expect(t.status).toBe("review");
    const commenti = db.prepare(
      "SELECT content, kind FROM task_comments WHERE task_id = ? ORDER BY created_at",
    ).all(taskId) as Array<{ content: string; kind: string }>;
    // Deve esserci una nota di servizio che annota la consegna muta.
    const notaMuta = commenti.find(
      (c) => c.kind === "service" && c.content.includes("senza riassunto"),
    );
    expect(notaMuta, "nota 'senza riassunto' deve comparire nel thread").toBeTruthy();
  });

  test("(b) turno con commento: nessuna nota di consegna muta", () => {
    const svc = createTaskService(db);
    const taskId = seedInProgress(db, svc);
    // Agente ha commentato in questo turno.
    db.prepare(
      "INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?,?,?,?,?,?)",
    ).run("c-1", taskId, "agent-abc", "fatto, guarda demo/", "comment", new Date().toISOString());

    const t = svc.deliverToReviewBySystem({ taskId, reason: "turni esauriti" });

    expect(t.status).toBe("review");
    const commenti = db.prepare(
      "SELECT content, kind FROM task_comments WHERE task_id = ?",
    ).all(taskId) as Array<{ content: string; kind: string }>;
    const notaMuta = commenti.find(
      (c) => c.kind === "service" && c.content.includes("senza riassunto"),
    );
    expect(notaMuta, "turno non muto: la nota non deve comparire").toBeFalsy();
  });

  /**
   * (c) CATENA review_needs_commit: ramo + deliveryFilesChanged === 0 =>
   * reviewEvidence.kind === 'uncommitted'.
   *
   * Il dispatcher chiama `captureDelivery` (git) PRIMA di
   * `deliverToReviewBySystem` e scrive `delivery_files_changed = 0` quando il
   * ramo non ha commit propri. Il servizio da solo non ha accesso a git, ma
   * riceve gia' il dato. Questo test verifica la catena a partire dal dato
   * scritto: il campo 0 porta `uncommitted`, che e' il chip che il reviewer
   * vede PRIMA di premere "Landa su main".
   */
  test("(c) ramo senza commit: reviewEvidence.kind === 'uncommitted'", () => {
    const svc = createTaskService(db);
    const taskId = seedInProgress(db, svc);
    // Simula captureDelivery: scrive il ramo con zero file committati.
    svc.recordDelivery({
      taskId, branch: "topics/somber-test", commit: null,
      stat: { filesChanged: 0, insertions: 0, deletions: 0 },
    });

    const t = svc.deliverToReviewBySystem({
      taskId, reason: "turni esauriti", cause: "retries_exhausted",
    });

    expect(t.status).toBe("review");
    expect(t.deliveryBranch).toBe("topics/somber-test");
    expect(t.deliveryFilesChanged).toBe(0);
    // Il chip visibile sulla card PRIMA che qualcuno provi a landare.
    const evidenza = reviewEvidence(t);
    expect(evidenza.kind).toBe("uncommitted");
    expect(evidenza.isolated).toBe(true);
  });

  test("(d) ramo CON commit: reviewEvidence.kind === 'measured'", () => {
    const svc = createTaskService(db);
    const taskId = seedInProgress(db, svc);
    svc.recordDelivery({
      taskId, branch: "topics/somber-test", commit: "abc123",
      stat: { filesChanged: 3, insertions: 12, deletions: 2 },
    });
    db.prepare(
      "INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?,?,?,?,?,?)",
    ).run("c-2", taskId, "agent-abc", "fatto", "comment", new Date().toISOString());

    const t = svc.deliverToReviewBySystem({ taskId, reason: "turni esauriti" });

    expect(reviewEvidence(t).kind).toBe("measured");
  });
});

// ── askParkedChildren ─────────────────────────────────────────────────────────

describe("askParkedChildren: porta di sistema annota review_needs_summary", () => {
  let db: Database;

  beforeEach(() => { db = withAttempts(freshDb()); });

  /**
   * Padre con un figlio parcheggiato in backlog: la condizione che spinge
   * `askParkedChildren` a portare il padre in review con la domanda.
   */
  function seedPadreConFiglioFermo(svc: ReturnType<typeof createTaskService>): string {
    const padre = svc.create({ text: "il padre", projectId: "pX" });
    const figlio = svc.create({ text: "il figlio", projectId: "pX", parentTaskId: padre.id });
    db.prepare("UPDATE tasks SET status = 'backlog' WHERE id = ?").run(figlio.id);
    // Il topic deve esistere prima di essere assegnato (FK).
    db.run("INSERT INTO topics (id) VALUES ('tp') ON CONFLICT DO NOTHING");
    db.prepare(
      "UPDATE tasks SET status = 'in_progress', assigned_topic_id = 'tp', dispatch_attempts = 1 WHERE id = ?",
    ).run(padre.id);
    db.prepare(
      "INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?,?,?,?,?,?)",
    ).run("st-2", padre.id, "dispatcher", "in_progress->in_progress", "status", new Date().toISOString());
    return padre.id;
  }

  test("(a) padre muto con figlio parcheggiato: nota 'senza riassunto' visibile", () => {
    const svc = createTaskService(db);
    const padreId = seedPadreConFiglioFermo(svc);

    const t = svc.askParkedChildren({ taskId: padreId, by: "dispatcher", evenIfLive: true });

    expect(t).not.toBeNull();
    expect(t!.status).toBe("review");
    const commenti = db.prepare(
      "SELECT content, kind FROM task_comments WHERE task_id = ? ORDER BY created_at",
    ).all(padreId) as Array<{ content: string; kind: string }>;
    const notaMuta = commenti.find(
      (c) => c.kind === "service" && c.content.includes("senza riassunto"),
    );
    expect(notaMuta, "nota 'senza riassunto' deve comparire sotto askParkedChildren").toBeTruthy();
  });

  test("(b) padre con commento e figlio parcheggiato: nessuna nota di consegna muta", () => {
    const svc = createTaskService(db);
    const padreId = seedPadreConFiglioFermo(svc);
    db.prepare(
      "INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?,?,?,?,?,?)",
    ).run("c-3", padreId, "agent-abc", "lavoro fatto", "comment", new Date().toISOString());

    const t = svc.askParkedChildren({ taskId: padreId, by: "dispatcher", evenIfLive: true });

    expect(t).not.toBeNull();
    expect(t!.status).toBe("review");
    const commenti = db.prepare(
      "SELECT content, kind FROM task_comments WHERE task_id = ?",
    ).all(padreId) as Array<{ content: string; kind: string }>;
    const notaMuta = commenti.find(
      (c) => c.kind === "service" && c.content.includes("senza riassunto"),
    );
    expect(notaMuta, "turno non muto: la nota non deve comparire").toBeFalsy();
  });
});

// ── Cinque cancelli pre-review ────────────────────────────────────────────────
//
// Non e' un test dei comandi (quelli vivono in server/routes/tasks.test.ts
// "checks pre-review"), ma della STRUTTURA: il predicato `hasFreshAgentComment`
// e' ora una funzione estratta e non una query inline. Questo verifica che la
// refactorizzazione non abbia cambiato il comportamento del gate dentro update()
// -- un agente senza commento non passa.

describe("cancello review_needs_summary: comportamento invariato dopo l'estrazione", () => {
  let db: Database;

  beforeEach(() => {
    db = withAttempts(freshDb());
    db.run("INSERT INTO topics (id) VALUES ('top-s1')");
  });

  test("agente senza commento: gate review_needs_summary (invariato)", () => {
    const svc = createTaskService(db);
    const t = svc.create({ text: "feat", projectId: "pX" });
    // Assegna il topic via SQL (CreateTaskInput non ha agentTopicId).
    db.prepare(
      "UPDATE tasks SET status = 'in_progress', assigned_topic_id = 'top-s1' WHERE id = ?",
    ).run(t.id);
    // Riga di stato per lastTurnStart.
    db.prepare(
      "INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?,?,?,?,?,?)",
    ).run("st-x", t.id, "dispatcher", "in_progress->in_progress", "status", new Date().toISOString());

    let thrown: unknown;
    try {
      svc.update({ taskId: t.id, actor: "agent", by: "top-s1", patch: { status: "review" } });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(TaskServiceError);
    expect((thrown as TaskServiceError).code).toBe("review_needs_summary");
  });

  test("agente con commento: review concessa (invariato)", () => {
    const svc = createTaskService(db);
    const t = svc.create({ text: "feat", projectId: "pX" });
    db.prepare(
      "UPDATE tasks SET status = 'in_progress', assigned_topic_id = 'top-s1' WHERE id = ?",
    ).run(t.id);
    db.prepare(
      "INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?,?,?,?,?,?)",
    ).run("st-y", t.id, "dispatcher", "in_progress->in_progress", "status", new Date().toISOString());
    // Commento fresco dell'agente.
    db.prepare(
      "INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?,?,?,?,?,?)",
    ).run("c-ag", t.id, "top-s1", "fatto, guarda demo/", "comment", new Date().toISOString());

    const updated = svc.update({
      taskId: t.id, actor: "agent", by: "top-s1", patch: { status: "review" },
    });
    expect(updated.status).toBe("review");
  });
});
