/**
 * Il PATTO: la ragione per cui una card è ferma esce dal server, già scritta.
 *
 * `shared/board.test.ts` prova che la regola è giusta. Questo prova l'altra
 * metà, quella che il client non può provare da solo: che la frase viaggia nel
 * payload. È la barra n.2 del task, e non è pedanteria — due dei tre
 * ingredienti non sono nemmeno sulla riga del task. L'interruttore di dispatch
 * sta in `board_settings`, e la posizione in coda si conta su TUTTE le board
 * (il tetto degli agenti è machine-wide) mentre la lista che il client ha in
 * mano è un progetto solo, `rootsOnly`, non archiviati. Un client che deducesse
 * risponderebbe «in coda» a una board spenta, con la faccia sicura.
 *
 * Lo stesso conto è già stato pagato due volte, con `blockedBy` e con
 * `waitingOnCount`.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, effort TEXT)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, auto_dispatch INTEGER NOT NULL DEFAULT 0,
    max_agents INTEGER DEFAULT 3, dispatch_retry_cap INTEGER
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  db.run(TASK_LABELS_DDL); // migration 100 — rowToTask la legge per OGNI task
  // L'interruttore acceso: la riga '*' È l'interruttore globale.
  db.run("INSERT INTO board_settings (project_id, auto_dispatch) VALUES ('*', 1)");
  return db;
}

const PID = "topics-app-abc123";

/** Spostare una card di colonna: `update` vuole sempre chi l'ha mossa. */
function mv(s: TaskService, taskId: string, status: string) {
  return s.update({ taskId, actor: "human", by: "attilio", patch: { status: status as never } });
}

let clock = 0;
function svc(db: Database): TaskService {
  let n = 0;
  // Ogni create avanza l'orologio di un minuto: l'anzianità è il criterio con
  // cui la coda rompe la parità di priorità, e con un istante solo per tutti
  // «quanti ne ho davanti» non sarebbe misurabile.
  return createTaskService(db, {
    now: () => new Date(Date.UTC(2026, 7, 12, 9, clock++)).toISOString(),
    uuid: () => `id-${++n}`,
  });
}

describe("la ragione della coda arriva dal server, con la card", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { clock = 0; db = freshDb(); s = svc(db); });

  test("in coda: il payload porta la frase, non i campi da cui dedurla", () => {
    const primo = s.create({ projectId: PID, text: "Il primo" });
    const secondo = s.create({ projectId: PID, text: "Il secondo" });
    const terzo = s.create({ projectId: PID, text: "Il terzo" });
    for (const t of [primo, secondo, terzo]) mv(s, t.id, "todo");

    // Il terzo entrato ha due task davanti: stessa priorità, più giovane.
    const r = s.get(terzo.id)!.task.queueReason!;
    expect(r).toMatchObject({ kind: "slot", tone: "queued", head: "in coda", detail: "2 davanti" });
    expect(s.get(primo.id)!.task.queueReason!.detail).toBe("la prossima");
  });

  test("la fila si conta su TUTTE le board: il tetto agenti è machine-wide", () => {
    // È il caso che il client non può calcolare: l'altra board non è nella sua
    // lista, ma il suo task consuma lo stesso slot.
    const altrove = s.create({ projectId: "un-altro-progetto", text: "Da un'altra board", priority: 4 });
    mv(s, altrove.id, "todo");
    const mio = s.create({ projectId: PID, text: "Il mio" });
    mv(s, mio.id, "todo");
    expect(s.get(mio.id)!.task.queueReason!.detail).toBe("1 davanti");
  });

  test("interruttore spento: la stessa card cambia ragione senza cambiare un campo suo", () => {
    const t = s.create({ projectId: PID, text: "Ferma" });
    mv(s, t.id, "todo");
    expect(s.get(t.id)!.task.queueReason!.kind).toBe("slot");

    // La riga del task non si tocca: cambia solo l'interruttore globale. Un
    // client che deducesse dai campi direbbe ancora «in coda».
    s.setGlobalAutoDispatch(false);
    const r = s.get(t.id)!.task.queueReason!;
    expect(r).toMatchObject({ kind: "dispatch_off", tone: "stalled", detail: "dispatch spento" });
  });

  test("bloccata da un'altra card, e la ragione si spegne quando quella chiude", () => {
    const bloccante = s.create({ projectId: PID, text: "Migrare le foto" });
    mv(s, bloccante.id, "in_progress");
    const dipendente = s.create({ projectId: PID, text: "Pubblicare", blockedByTaskId: bloccante.id });
    mv(s, dipendente.id, "todo");

    const r = s.get(dipendente.id)!.task.queueReason!;
    expect(r.kind).toBe("blocked");
    expect(r.detail).toBe(`aspetta ${bloccante.id.slice(0, 8)}`);
    // Il titolo del bloccante lo risolve il server: sulla card non c'è.
    expect(r.title).toContain("Migrare le foto");

    mv(s, bloccante.id, "done");
    expect(s.get(dipendente.id)!.task.queueReason!.kind).toBe("slot");
  });

  test("il tetto dei tentativi è della BOARD, e la ragione lo legge da lì", () => {
    const t = s.create({ projectId: PID, text: "Ci ha provato due volte" });
    mv(s, t.id, "todo");
    db.prepare("UPDATE tasks SET dispatch_attempts = 2 WHERE id = ?").run(t.id);
    expect(s.get(t.id)!.task.queueReason).toMatchObject({
      kind: "attempts", tone: "stalled", detail: "tentativi finiti, rimettila in coda",
    });

    // Alzato il tetto, la stessa riga torna idonea: il numero non è sul task.
    db.prepare("INSERT INTO board_settings (project_id, dispatch_retry_cap) VALUES (?, 4)").run(PID);
    expect(s.get(t.id)!.task.queueReason!.kind).toBe("slot");
  });

  test("rinviata: la finestra viene dal task, la frase dal server", () => {
    const t = s.create({ projectId: PID, text: "Aspetta la UAT" });
    mv(s, t.id, "todo");
    const fra20 = new Date(Date.now() + 20 * 60_000).toISOString();
    db.prepare("UPDATE tasks SET dispatch_deferred_until = ? WHERE id = ?").run(fra20, t.id);
    const r = s.get(t.id)!.task.queueReason!;
    expect(r).toMatchObject({ kind: "deferred", tone: "waiting", head: "rinviata" });
    expect(r.detail).toMatch(/^riprende fra (19|20|21) min$/);
  });

  test("uno step in todo dice del padre, non della coda", () => {
    const padre = s.create({ projectId: PID, text: "L'epica" });
    mv(s, padre.id, "review");
    const step = s.create({ projectId: PID, text: "Uno step", parentTaskId: padre.id });
    mv(s, step.id, "todo");
    expect(s.get(step.id)!.task.queueReason).toMatchObject({
      kind: "parent_review", tone: "stalled", detail: "il padre aspetta te",
    });
  });

  test("«aspetta uno slot» e «non partirà mai» escono distinti dallo stesso endpoint", () => {
    // Barra n.3, misurata sul payload: due card nella stessa colonna, due toni.
    const scorre = s.create({ projectId: PID, text: "Idonea" });
    const mai = s.create({ projectId: PID, text: "Esaurita" });
    for (const t of [scorre, mai]) mv(s, t.id, "todo");
    db.prepare("UPDATE tasks SET dispatch_attempts = 9 WHERE id = ?").run(mai.id);

    const lista = s.list({ scope: "project", projectId: PID, status: "todo" });
    const toni = Object.fromEntries(lista.map((t) => [t.text, t.queueReason?.tone]));
    expect(toni).toEqual({ Idonea: "queued", Esaurita: "stalled" });
  });

  test("fuori da todo il campo è `null`: la domanda non si pone", () => {
    const t = s.create({ projectId: PID, text: "In corso" });
    mv(s, t.id, "in_progress");
    expect(s.get(t.id)!.task.queueReason).toBeNull();
    mv(s, t.id, "review");
    // In review SENZA sottotask aperti resta null: la review è una consegna
    // normale, e il chip di stato dice già tutto.
    expect(s.get(t.id)!.task.queueReason).toBeNull();
  });

  /**
   * Il conto dei sottotask aperti è l'ingrediente che il client NON ha: la sua
   * lista è un progetto solo, `rootsOnly`, non archiviati, e i figli non ci
   * stanno dentro. `subtaskCount` esiste sul payload, ma lo riempiono solo
   * `list`/`get` — dopo `rowToTask`, cioè dopo che la ragione è già stata
   * scritta — quindi nemmeno quello risponderebbe sulle scritture.
   */
  test("in review con la checklist aperta la card dice PERCHÉ è ferma", () => {
    const padre = s.create({ projectId: PID, text: "Il padre" });
    s.create({ projectId: PID, text: "Passo uno", parentTaskId: padre.id });
    s.create({ projectId: PID, text: "Passo due", parentTaskId: padre.id });
    mv(s, padre.id, "review");
    const r = s.get(padre.id)!.task.queueReason!;
    expect(r).toMatchObject({ kind: "checklist_frozen", tone: "stalled" });
    expect(r.detail).toBe("2 sottotask aperti");
  });

  test("chiusi i sottotask, la stessa card in review torna muta", () => {
    const padre = s.create({ projectId: PID, text: "Il padre" });
    const figlio = s.create({ projectId: PID, text: "Passo uno", parentTaskId: padre.id });
    mv(s, padre.id, "review");
    expect(s.get(padre.id)!.task.queueReason!.kind).toBe("checklist_frozen");
    mv(s, figlio.id, "done");
    expect(s.get(padre.id)!.task.queueReason).toBeNull();
  });

  test("la ragione viaggia sulla SCRITTURA che porta la card in review", () => {
    const padre = s.create({ projectId: PID, text: "Il padre" });
    s.create({ projectId: PID, text: "Passo uno", parentTaskId: padre.id });
    expect(mv(s, padre.id, "review").queueReason).toMatchObject({ kind: "checklist_frozen" });
  });

  test("la ragione viaggia anche sul payload di una SCRITTURA, non solo su list/get", () => {
    // È lo stesso guasto di `waitingOnCount`: un contatore riempito solo dai
    // fetch si azzera al primo `task:updated` che passa dal WS, cioè proprio
    // mentre l'umano guarda la card che ha appena mosso.
    const t = s.create({ projectId: PID, text: "Appena mossa" });
    const dopo = mv(s, t.id, "todo");
    expect(dopo.queueReason).toMatchObject({ kind: "slot", head: "in coda" });
  });
});
