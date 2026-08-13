import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, TaskServiceError, type TaskService } from "./tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

/**
 * La fusione di due card, e la promessa che la regge: non si perde niente.
 *
 * Il rischio di questa funzione non e' sbagliare il verdetto (quello lo decide
 * chi preme il tasto): e' far sparire lavoro. Un sottotask che finisce sotto una
 * card archiviata e' irraggiungibile, un thread che resta attaccato alla card
 * sbagliata e' un thread perso. Ogni test qui sotto controlla una di queste due
 * cose, e nessuno controlla l'estetica del risultato.
 */

// La DDL di `tasks` NON si ricopia qui. Una copia a mano è verde il giorno che
// la scrivi e rossa alla prima colonna aggiunta da qualcun altro: questo file è
// nato con una copia e si è ritrovato 22 test rossi su `created_by_topic_id`,
// una colonna arrivata su main mentre il ramo aspettava. La sorgente unica è
// `server/db/test-schema.ts`, tenuta identica alle migration dal test accanto.
const DDL = {
  comments: `CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`,
  settings: `CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_mcp TEXT, dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER, review_checks TEXT,
    dispatch_fanout INTEGER
  )`,
};

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(DDL.comments);
  db.run(DDL.settings);
  return db;
}

const PID = "topics-app-abc123";
let db: Database;
let svc: TaskService;
let clock: { t: number };

beforeEach(() => {
  db = freshDb();
  clock = { t: Date.parse("2026-08-12T10:00:00.000Z") };
  let n = 0;
  svc = createTaskService(db, {
    now: () => new Date((clock.t += 1000)).toISOString(),
    uuid: () => `id-${++n}`,
  });
});

/** Due card vere della board, riscritte due volte con parole diverse. */
function twoCards() {
  const survivor = svc.create({ projectId: PID, text: "store: UserMemoryStore.update() + test" });
  const dupe = svc.create({ projectId: PID, text: "store: UserMemoryStore.update() + unit test" });
  return { survivor, dupe };
}

describe("fusione: niente si perde", () => {
  test("il thread della card assorbita finisce sulla superstite", () => {
    const { survivor, dupe } = twoCards();
    svc.addComment({ taskId: dupe.id, author: "user", content: "questa la faccio io" });
    svc.addComment({ taskId: dupe.id, author: "agent", content: "fatto, ramo consegnato" });

    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });

    const after = svc.get(survivor.id)!;
    const testi = after.comments.map((c) => c.content);
    expect(testi).toContain("questa la faccio io");
    expect(testi).toContain("fatto, ramo consegnato");
  });

  test("l'autore di ogni commento resta quello di prima", () => {
    const { survivor, dupe } = twoCards();
    svc.addComment({ taskId: dupe.id, author: "agent", content: "fatto, ramo consegnato" });
    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });
    const spostato = svc.get(survivor.id)!.comments.find((c) => c.content === "fatto, ramo consegnato");
    expect(spostato!.author).toBe("agent");
  });

  test("i sottotask passano sotto la superstite, VIVI", () => {
    const { survivor, dupe } = twoCards();
    const figlio = svc.create({ projectId: PID, text: "test unit dello store", parentTaskId: dupe.id });

    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });

    const after = svc.get(survivor.id)!;
    expect(after.children.map((c) => c.id)).toContain(figlio.id);
    // Il difetto da evitare: archive() cascata sul sottoalbero. Se il figlio
    // non fosse stato staccato PRIMA, sarebbe archiviato e irraggiungibile.
    const row = db.prepare("SELECT archived, parent_task_id FROM tasks WHERE id = ?").get(figlio.id) as any;
    expect(row.archived).toBe(0);
    expect(row.parent_task_id).toBe(survivor.id);
  });

  test("anche i nipoti restano visibili", () => {
    const { survivor, dupe } = twoCards();
    const figlio = svc.create({ projectId: PID, text: "test unit dello store", parentTaskId: dupe.id });
    const nipote = svc.create({ projectId: PID, text: "caso limite: chiave assente", parentTaskId: figlio.id });

    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });

    // Il nipote non viene MAI spostato (resta sotto suo padre): sopravvive solo
    // perche' il padre e' uscito dal sottoalbero prima che la cascata passasse.
    const row = db.prepare("SELECT archived, parent_task_id FROM tasks WHERE id = ?").get(nipote.id) as any;
    expect(row.archived).toBe(0);
    expect(row.parent_task_id).toBe(figlio.id);
  });

  test("la card assorbita e' archiviata, non cancellata", () => {
    const { survivor, dupe } = twoCards();
    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });
    const row = db.prepare("SELECT archived FROM tasks WHERE id = ?").get(dupe.id) as any;
    expect(row).toBeTruthy(); // la riga c'e' ancora
    expect(row.archived).toBe(1);
  });

  test("le due card dicono dove e' finito il lavoro", () => {
    const { survivor, dupe } = twoCards();
    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });

    const suSuperstite = svc.get(survivor.id)!.comments.map((c) => c.content).join("\n");
    expect(suSuperstite).toContain(dupe.id.slice(0, 8));
    const suAssorbita = db
      .prepare("SELECT content FROM task_comments WHERE task_id = ?")
      .all(dupe.id)
      .map((r: any) => r.content)
      .join("\n");
    expect(suAssorbita).toContain(survivor.id.slice(0, 8));
  });

  test("il conto tornato dice quanto ha spostato", () => {
    const { survivor, dupe } = twoCards();
    svc.addComment({ taskId: dupe.id, author: "user", content: "uno" });
    svc.addComment({ taskId: dupe.id, author: "user", content: "due" });
    svc.create({ projectId: PID, text: "sottotask", parentTaskId: dupe.id });

    const esito = svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });
    expect(esito.movedComments).toBe(2);
    expect(esito.movedChildren).toBe(1);
    expect(esito.survivor.id).toBe(survivor.id);
    expect(esito.merged.id).toBe(dupe.id);
    // `Task` non espone `archived` (l'API non restituisce mai card archiviate):
    // che la card sia uscita dalla board lo dice la riga, ed e' il test sopra.
    expect(esito.survivor.subtaskCount).toBe(1);
  });
});

describe("fusione: chi aspettava la card assorbita aspetta ancora", () => {
  test("il puntatore `bloccata da` passa alla superstite, e il blocco TIENE", () => {
    const { survivor, dupe } = twoCards();
    const dipendente = svc.create({ projectId: PID, text: "la card che aspetta lo store", blockedByTaskId: dupe.id });
    expect(svc.isDispatchBlocked(dipendente.id)).toBe(true);

    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });

    const row = db.prepare("SELECT blocked_by_task_id FROM tasks WHERE id = ?").get(dipendente.id) as any;
    expect(row.blocked_by_task_id).toBe(survivor.id);
    // Il difetto vero: archiviare il bloccante lo fa contare come "finito"
    // (isDispatchBlocked guarda `status='done' OR archived=1`). Senza il
    // ripuntamento il dipendente parte mentre il lavoro e' ancora da fare.
    expect(svc.isDispatchBlocked(dipendente.id)).toBe(true);
    expect(svc.listBlockedBy(survivor.id).map((t) => t.id)).toContain(dipendente.id);
  });

  test("finito il lavoro sulla superstite, il dipendente si sblocca", () => {
    const { survivor, dupe } = twoCards();
    const dipendente = svc.create({ projectId: PID, text: "la card che aspetta lo store", blockedByTaskId: dupe.id });
    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(survivor.id);
    expect(svc.isDispatchBlocked(dipendente.id)).toBe(false);
  });

  test("la superstite non diventa bloccante di se stessa", () => {
    const { survivor, dupe } = twoCards();
    // La superstite aspettava proprio la card che ora assorbe: il prerequisito
    // e' diventato lei stessa, quindi non c'e' piu' niente da aspettare.
    db.prepare("UPDATE tasks SET blocked_by_task_id = ? WHERE id = ?").run(dupe.id, survivor.id);

    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });

    const row = db.prepare("SELECT blocked_by_task_id FROM tasks WHERE id = ?").get(survivor.id) as any;
    expect(row.blocked_by_task_id).toBe(null);
    expect(svc.isDispatchBlocked(survivor.id)).toBe(false);
  });

  test("nessun anello: chi bloccava la superstite non ripunta su di lei", () => {
    const { survivor, dupe } = twoCards();
    // survivor aspetta `ponte`, e `ponte` aspetta `dupe`. Ripuntare `ponte`
    // sulla superstite chiuderebbe l'anello survivor -> ponte -> survivor, e i
    // due resterebbero fermi per sempre.
    const ponte = svc.create({ projectId: PID, text: "il ponte fra le due", blockedByTaskId: dupe.id });
    db.prepare("UPDATE tasks SET blocked_by_task_id = ? WHERE id = ?").run(ponte.id, survivor.id);

    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });

    const row = db.prepare("SELECT blocked_by_task_id FROM tasks WHERE id = ?").get(ponte.id) as any;
    expect(row.blocked_by_task_id).not.toBe(survivor.id);
    expect(svc.isDispatchBlocked(ponte.id)).toBe(false);
  });

  test("il conto tornato dice quanti puntatori ha spostato", () => {
    const { survivor, dupe } = twoCards();
    svc.create({ projectId: PID, text: "prima che aspetta", blockedByTaskId: dupe.id });
    svc.create({ projectId: PID, text: "seconda che aspetta", blockedByTaskId: dupe.id });
    const esito = svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });
    expect(esito.movedBlockers).toBe(2);
    // E la ricevuta lo dice: chi legge il thread della superstite deve sapere
    // che ora ha due card appese, non scoprirlo quando un dispatch parte.
    const ricevuta = svc.get(survivor.id)!.comments.map((c) => c.content).join("\n");
    expect(ricevuta).toContain("2 card che aspettavano quella");
  });

  test("senza dipendenti la ricevuta non inventa niente", () => {
    const { survivor, dupe } = twoCards();
    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });
    const ricevuta = svc.get(survivor.id)!.comments.map((c) => c.content).join("\n");
    expect(ricevuta).not.toContain("aspettav");
  });
});

describe("fusione: quando si rifiuta", () => {
  test("una card non si fonde con se stessa", () => {
    const { survivor } = twoCards();
    expect(() => svc.merge({ taskId: survivor.id, intoTaskId: survivor.id, by: "attilio" })).toThrow(TaskServiceError);
  });

  test("non si fondono card di board diverse", () => {
    const { dupe } = twoCards();
    const altrove = svc.create({ projectId: "altro-progetto", text: "store: UserMemoryStore.update() + unit test" });
    expect(() => svc.merge({ taskId: dupe.id, intoTaskId: altrove.id, by: "attilio" })).toThrow(/board/);
  });

  test("una card con un agente vivo non si fonde: il worktree resterebbe orfano", () => {
    const { survivor, dupe } = twoCards();
    db.prepare("UPDATE tasks SET dispatch_state = 'working' WHERE id = ?").run(dupe.id);
    expect(() => svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" })).toThrow(/agente/);
  });

  test("una card gia' archiviata non si fonde una seconda volta", () => {
    const { survivor, dupe } = twoCards();
    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });
    expect(() => svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" })).toThrow(TaskServiceError);
  });

  test("la superstite non puo' essere un sottotask della card che sparisce", () => {
    const { dupe } = twoCards();
    const figlio = svc.create({ projectId: PID, text: "il figlio", parentTaskId: dupe.id });
    // Fondere il padre DENTRO il figlio lascerebbe il figlio genitore di se stesso.
    expect(() => svc.merge({ taskId: dupe.id, intoTaskId: figlio.id, by: "attilio" })).toThrow(/sottotask/);
  });
});

describe("doppioni al momento della creazione", () => {
  test("la board dice quali card gia' dicono questa cosa", () => {
    const { survivor } = twoCards();
    const vicini = svc.findDuplicates({ projectId: PID, text: "store: UserMemoryStore.update() + unit test" });
    expect(vicini.some((v) => v.task.id === survivor.id && v.duplicate)).toBe(true);
  });

  test("un titolo nuovo non produce vicini", () => {
    twoCards();
    expect(svc.findDuplicates({ projectId: PID, text: "Sonda della CPU vera sotto carico" })).toEqual([]);
  });

  test("una card archiviata non conta come doppione: e' gia' fuori dalla board", () => {
    const { survivor, dupe } = twoCards();
    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });
    const vicini = svc.findDuplicates({ projectId: PID, text: "store: UserMemoryStore.update() + unit test" });
    expect(vicini.map((v) => v.task.id)).not.toContain(dupe.id);
  });

  test("il doppione si cerca sulla PROPRIA board, non su tutte", () => {
    twoCards();
    const vicini = svc.findDuplicates({ projectId: "altro-progetto", text: "store: UserMemoryStore.update() + unit test" });
    expect(vicini).toEqual([]);
  });
});
