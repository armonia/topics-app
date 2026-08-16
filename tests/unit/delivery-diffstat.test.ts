/**
 * LA REVIEW DEVE DIRE COSA SI STA APPROVANDO.
 *
 * Misurato sulla board vera il 16/08: cinque card in review, e su tutte e
 * cinque il pulsante «Approva» senza un solo dato su cosa entrerebbe. Nessun
 * file, nessuna riga, nessun esito dei controlli. La descrizione ripeteva il
 * titolo e l'unica informazione era «riaperta 4».
 *
 * Il diff esisteva già, ma solo dietro l'apertura del drawer: una card alla
 * volta. Una colonna che si legge solo aprendola non è un cruscotto, è un
 * elenco di titoli.
 *
 * Questi casi difendono il contratto del dato, che è la parte che si rompe per
 * prima: `null` significa NON MISURATO e deve restare distinto da zero, che
 * significa «misurato, non ha prodotto niente». Confonderli fa comparire
 * «0 file +0 -0» su ogni card senza worktree, cioè rumore su una superficie che
 * esiste per essere letta di fretta.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "../../server/services/tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../../server/db/test-schema";

function conTask(): { svc: TaskService; id: string } {
  const d = new Database(":memory:");
  d.run("PRAGMA foreign_keys = ON");
  d.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, effort TEXT)`);
  d.run(TASKS_DDL);
  d.run(TASKS_FK_STUBS_DDL);
  d.run(TASK_LABELS_DDL);
  // Le tabelle che `create` tocca di striscio: senza, il test morirebbe su un
  // "no such table" che non c'entra niente con cio' che sta misurando.
  d.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  d.run(`CREATE TABLE IF NOT EXISTS app_settings (id INTEGER PRIMARY KEY CHECK (id = 1), auto_dispatch INTEGER)`);
  d.run(`INSERT OR IGNORE INTO app_settings (id, auto_dispatch) VALUES (1, 0)`);
  d.run(`CREATE TABLE IF NOT EXISTS board_settings (
    project_id TEXT PRIMARY KEY, auto_dispatch INTEGER NOT NULL DEFAULT 0,
    max_agents INTEGER DEFAULT 3, max_agents_auto INTEGER, dispatch_retry_cap INTEGER
  )`);
  const svc = createTaskService(d);
  const t = svc.create({ projectId: "p", text: "una card" });
  return { svc, id: t.id };
}

describe("l'entità della consegna arriva alla card", () => {
  it("una consegna MISURATA porta file e righe fino al task", () => {
    const { svc, id } = conTask();
    svc.recordDelivery({
      taskId: id, branch: "topics/x", commit: "a".repeat(40),
      stat: { filesChanged: 7, insertions: 120, deletions: 30 },
    });
    const t = svc.get(id)!.task;
    expect(t.deliveryFilesChanged).toBe(7);
    expect(t.deliveryInsertions).toBe(120);
    expect(t.deliveryDeletions).toBe(30);
  });

  it("senza misura resta NULL, non zero", () => {
    // È la distinzione che tiene onesta la card: `null` non disegna niente,
    // zero direbbe «questa consegna non ha prodotto niente». Su una card senza
    // worktree la seconda frase è falsa.
    const { svc, id } = conTask();
    svc.recordDelivery({ taskId: id, branch: "topics/x", commit: "b".repeat(40) });
    const t = svc.get(id)!.task;
    expect(t.deliveryFilesChanged).toBeNull();
    expect(t.deliveryInsertions).toBeNull();
    expect(t.deliveryDeletions).toBeNull();
  });

  it("una consegna VUOTA misurata dice zero, e zero è un'informazione", () => {
    // Un ramo che non cambia niente esiste (un revert, un merge già dentro), e
    // dirlo è utile: «misurato, non ha prodotto niente» è la risposta a
    // «cos'ha fatto l'agente», mentre il silenzio non lo è.
    const { svc, id } = conTask();
    svc.recordDelivery({
      taskId: id, branch: "topics/x", commit: "c".repeat(40),
      stat: { filesChanged: 0, insertions: 0, deletions: 0 },
    });
    expect(svc.get(id)!.task.deliveryFilesChanged).toBe(0);
  });

  it("una consegna NUOVA non eredita la misura di quella vecchia", () => {
    // Il caso che rende il dato pericoloso invece che utile: i numeri
    // descrivono UNA consegna. Lasciarli su una consegna nuova non misurata
    // farebbe leggere sulla card il lavoro di prima, ed è peggio del non
    // saperlo — perché sembra una risposta.
    const { svc, id } = conTask();
    svc.recordDelivery({
      taskId: id, branch: "topics/x", commit: "d".repeat(40),
      stat: { filesChanged: 9, insertions: 99, deletions: 9 },
    });
    expect(svc.get(id)!.task.deliveryFilesChanged).toBe(9);

    svc.recordDelivery({ taskId: id, branch: "topics/y", commit: "e".repeat(40) });
    expect(svc.get(id)!.task.deliveryFilesChanged, "la misura cade con la consegna che descriveva").toBeNull();
  });

  it("la LISTA la porta, non solo il dettaglio", () => {
    // La card della colonna si disegna dal feed della lista, non da `get`: se
    // il campo esistesse solo nel dettaglio, il chip non comparirebbe mai
    // proprio dove serve — ed è esattamente il difetto di partenza (il diff
    // c'era, ma solo dentro il drawer).
    const { svc, id } = conTask();
    svc.recordDelivery({
      taskId: id, branch: "topics/x", commit: "f".repeat(40),
      stat: { filesChanged: 3, insertions: 10, deletions: 2 },
    });
    const dallaLista = svc.list({ scope: "project", projectId: "p" }).find((t) => t.id === id)!;
    expect(dallaLista.deliveryFilesChanged).toBe(3);
    expect(dallaLista.deliveryInsertions).toBe(10);
  });
});
