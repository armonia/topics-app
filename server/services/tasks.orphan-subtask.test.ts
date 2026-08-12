/**
 * UN SOTTOTASK È LA CHECKLIST DI QUALCUNO. SE QUEL QUALCUNO NON C'È PIÙ, LA
 * CHECKLIST NON È PIÙ DI NESSUNO — E DEVE TORNARE VISIBILE.
 *
 * Il feed della board è `rootsOnly` (`server/routes/tasks.ts`, entrambe le
 * rotte): uno step non si disegna come card, perché non è arretrato — lo lavora
 * l'agente del padre dentro il proprio turno, e contarlo in colonna rende
 * «backlog 0» irraggiungibile per costruzione finché un padre lavora. Quella
 * metà è già a posto e questi test la tengono ferma.
 *
 * L'altra metà no. Con `rootsOnly` secco, uno step il cui padre è CHIUSO sparisce
 * da ogni colonna: nessuno lo dispaccia (gli step non sono mai idonei), il padre
 * è in Done e quindi nessuno ne apre più l'albero, e la sonda dei figli
 * parcheggiati esce subito su un padre `done`. È un vicolo cieco perfetto: la
 * board lo nasconde invece di risolverlo.
 *
 * Il buco che ci si arriva è nella porta d'ingresso: `create` e il re-parenting
 * rifiutano un padre ARCHIVIATO ma accettano un padre `done` — quindi lo stato
 * si costruisce con una chiamata legittima, non con una riga corrotta.
 *
 * Le due situazioni devono restare DISTINGUIBILI, ed è il punto di questi test:
 * padre vivo ⇒ la colonna conta UNO (lo step sta nella checklist); padre chiuso
 * ⇒ lo step riappare, perché non è la checklist di nessuno.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, TaskServiceError, type TaskService } from "./tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

const PID = "proj-orfani";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, effort TEXT)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    auto_dispatch INTEGER DEFAULT 0, dispatch_retry_cap INTEGER DEFAULT 2
  )`);
  return db;
}

/** Chiude un padre a SQL grezzo: il cancello `open_subtasks` lo rifiuterebbe,
 *  ed è proprio lo stato già presente in produzione che va fatto riemergere. */
function chiudiAMano(db: Database, id: string): void {
  db.run("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?", [new Date().toISOString(), id]);
}

describe("il feed della board e i sottotask orfani", () => {
  let db: Database;
  let s: TaskService;
  beforeEach(() => { db = freshDb(); s = createTaskService(db); });

  test("padre VIVO: i suoi step non sono card, la colonna conta UNO", () => {
    const padre = s.create({ projectId: PID, text: "epic", status: "todo" });
    s.create({ projectId: PID, text: "step 1", parentTaskId: padre.id, status: "todo" });
    s.create({ projectId: PID, text: "step 2", parentTaskId: padre.id, status: "todo" });

    const colonna = s.list({ scope: "project", projectId: PID, status: "todo", rootsOnly: true, includeOrphanSubtasks: true });
    expect(colonna.map((t) => t.id)).toEqual([padre.id]);
    // Lo stesso taglio sul feed globale.
    expect(s.list({ scope: "all", status: "todo", rootsOnly: true, includeOrphanSubtasks: true }).map((t) => t.id)).toEqual([padre.id]);
  });

  test("padre CHIUSO: lo step aperto NON sparisce dal feed", () => {
    const padre = s.create({ projectId: PID, text: "epic", status: "todo" });
    const step = s.create({ projectId: PID, text: "step rimasto", parentTaskId: padre.id, status: "todo" });
    chiudiAMano(db, padre.id);

    const feed = s.list({ scope: "project", projectId: PID, status: "todo", rootsOnly: true, includeOrphanSubtasks: true });
    expect(feed.map((t) => t.id)).toEqual([step.id]);
    expect(s.list({ scope: "all", status: "todo", rootsOnly: true, includeOrphanSubtasks: true }).map((t) => t.id)).toEqual([step.id]);
  });

  test("padre ARCHIVIATO a mano: lo step aperto NON sparisce dal feed", () => {
    // L'archiviazione dalla porta di servizio fa cascata sull'albero, quindi
    // questo stato si raggiunge solo scrivendo la riga: resta comunque uno
    // stato che il DB può avere, e nasconderlo è il guasto.
    const padre = s.create({ projectId: PID, text: "epic", status: "todo" });
    const step = s.create({ projectId: PID, text: "step rimasto", parentTaskId: padre.id, status: "todo" });
    db.run("UPDATE tasks SET archived = 1 WHERE id = ?", [padre.id]);

    const feed = s.list({ scope: "project", projectId: PID, status: "todo", rootsOnly: true, includeOrphanSubtasks: true });
    expect(feed.map((t) => t.id)).toEqual([step.id]);
  });

  test("padre SPARITO non è uno stato raggiungibile: la FK su `parent_task_id` lo rifiuta", () => {
    // Il taglio del feed regge anche il padre mancante (`NOT EXISTS`), ma la
    // riga non può sparire: `parent_task_id TEXT REFERENCES tasks(id)` senza
    // cascata, con `PRAGMA foreign_keys = ON` come in produzione. È il motivo
    // per cui l'archiviazione fa soft-delete a cascata invece di cancellare —
    // e la ragione per cui i tre casi da coprire sono chiuso, archiviato e
    // (per difesa) padre assente, non «cancellato».
    const padre = s.create({ projectId: PID, text: "epic", status: "todo" });
    s.create({ projectId: PID, text: "step rimasto", parentTaskId: padre.id, status: "todo" });

    expect(() => db.run("DELETE FROM tasks WHERE id = ?", [padre.id])).toThrow(/FOREIGN KEY/);
  });

  test("uno step CHIUSO sotto un padre chiuso resta fuori: non c'è niente da risolvere", () => {
    const padre = s.create({ projectId: PID, text: "epic", status: "todo" });
    const step = s.create({ projectId: PID, text: "step finito", parentTaskId: padre.id, status: "todo" });
    s.update({ taskId: step.id, actor: "human", by: "test", patch: { status: "done" } });
    chiudiAMano(db, padre.id);

    expect(s.list({ scope: "project", projectId: PID, rootsOnly: true, includeOrphanSubtasks: true }).map((t) => t.id)).toEqual([padre.id]);
  });

  test("il DISPATCHER continua a non vedere NESSUNO step: `rootsOnly` puro resta puro", () => {
    // La lista del tick (`task-dispatcher.ts`) è questa, e allargarla farebbe
    // partire un agente su uno step — che è precisamente la regola «Steps are
    // never dispatch-eligible». La visibilità è del FEED, non della coda.
    const padre = s.create({ projectId: PID, text: "epic", status: "todo" });
    s.create({ projectId: PID, text: "step rimasto", parentTaskId: padre.id, status: "todo" });
    chiudiAMano(db, padre.id);

    const coda = s.list({ scope: "project", projectId: PID, status: "todo", rootsOnly: true, includeOrphanSubtasks: false });
    expect(coda).toEqual([]);
  });
});

describe("la porta che crea gli orfani", () => {
  let db: Database;
  let s: TaskService;
  beforeEach(() => { db = freshDb(); s = createTaskService(db); });

  test("non si annida un task sotto un padre GIÀ CHIUSO", () => {
    const padre = s.create({ projectId: PID, text: "epic", status: "todo" });
    s.update({ taskId: padre.id, actor: "human", by: "test", patch: { status: "done" } });

    expect(() => s.create({ projectId: PID, text: "tardivo", parentTaskId: padre.id }))
      .toThrow(TaskServiceError);
  });

  test("non si RI-annida un task esistente sotto un padre già chiuso", () => {
    const padre = s.create({ projectId: PID, text: "epic", status: "todo" });
    s.update({ taskId: padre.id, actor: "human", by: "test", patch: { status: "done" } });
    const orfano = s.create({ projectId: PID, text: "indipendente", status: "todo" });

    expect(() => s.update({ taskId: orfano.id, actor: "human", by: "test", patch: { parentTaskId: padre.id } }))
      .toThrow(TaskServiceError);
  });
});
