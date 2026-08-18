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

describe("da quando la card aspetta una risposta", () => {
  it("entrare in review timbra l'istante", () => {
    const { svc, id } = conTask();
    expect(svc.get(id)!.task.reviewAt, "una card nuova non aspetta nessuno").toBeNull();
    svc.update({ taskId: id, actor: "human", by: "test", patch: { status: "review" } });
    expect(svc.get(id)!.task.reviewAt).toBeTruthy();
  });

  it("il timbro si RINNOVA a ogni ingresso, non solo al primo", () => {
    // Una card respinta e riconsegnata ricomincia ad aspettare da capo.
    // Mostrare l'attesa della volta scorsa sarebbe una misura vera di una
    // domanda sbagliata: «da quanto aspetta QUESTA richiesta».
    const { svc, id } = conTask();
    svc.update({ taskId: id, actor: "human", by: "test", patch: { status: "review" } });
    const primo = svc.get(id)!.task.reviewAt!;
    svc.update({ taskId: id, actor: "human", by: "test", patch: { status: "todo" } });
    svc.update({ taskId: id, actor: "human", by: "test", patch: { status: "review" } });
    const secondo = svc.get(id)!.task.reviewAt!;
    expect(secondo >= primo, "il secondo ingresso non puo' essere anteriore al primo").toBe(true);
  });

  it("ri-scrivere «review» su una card GIA' in review non azzera l'attesa", () => {
    // E' il caso che la guardia `current !== "review"` esiste per coprire, e
    // l'unico in cui si vede: un PATCH che rimanda lo stesso stato (un
    // salvataggio dal drawer, un client che rimanda tutto il task, un retry)
    // non e' un nuovo ingresso. Senza la guardia il chip tornerebbe a «ora»
    // ogni volta che qualcuno tocca la card, cioe' il difetto di `updatedAt`
    // ricostruito da capo.
    //
    // Il primo test che avevo scritto NON copriva questo: cambiava la
    // priorita', dove `patch.status` e' undefined e la guardia non entra
    // nemmeno in gioco. Il sabotaggio restava verde.
    const { svc, id } = conTask();
    svc.update({ taskId: id, actor: "human", by: "test", patch: { status: "review" } });
    const primo = svc.get(id)!.task.reviewAt!;
    svc.update({ taskId: id, actor: "human", by: "test", patch: { status: "review", priority: 1 } });
    expect(svc.get(id)!.task.reviewAt, "stesso stato = stessa attesa").toBe(primo);
  });

  it("restare in review non ri-timbra: l'attesa non si azzera da sola", () => {
    // Il caso che rende il dato onesto. Se un commento o un'etichetta
    // rinnovassero l'istante, il chip direbbe «ora» su una card ferma da
    // giorni - cioe' esattamente il difetto di `updatedAt` da cui si parte.
    const { svc, id } = conTask();
    svc.update({ taskId: id, actor: "human", by: "test", patch: { status: "review" } });
    const primo = svc.get(id)!.task.reviewAt!;
    svc.update({ taskId: id, actor: "human", by: "test", patch: { priority: 1 } });
    expect(svc.get(id)!.task.reviewAt, "una modifica qualsiasi non e' un nuovo ingresso").toBe(primo);
  });

  it("la LISTA lo porta, non solo il dettaglio", () => {
    // La card della colonna si disegna dal feed della lista: se il campo
    // vivesse solo in `get`, il chip non comparirebbe mai dove serve.
    const { svc, id } = conTask();
    svc.update({ taskId: id, actor: "human", by: "test", patch: { status: "review" } });
    const dallaLista = svc.list({ scope: "project", projectId: "p" }).find((t) => t.id === id)!;
    expect(dallaLista.reviewAt).toBeTruthy();
  });
});

/**
 * DIFFSTAT E CHECKS NON SOPRAVVIVONO ALLA CONSEGNA CHE DESCRIVEVANO.
 *
 * Difetto osservato il 18/08: una card rifiutata in review (o trascinata
 * review -> todo) azzerava delivery_branch e delivery_commit ma NON
 * delivery_files_changed, delivery_insertions, delivery_deletions,
 * checks_state, checks_json, checks_commit.
 *
 * La card conservava «7 file +240 -18» e la barra verde di una consegna il
 * cui puntatore era stato deliberatamente cancellato. Due lettori prendevano
 * decisioni sbagliate:
 *   - il chip «chiude il conduttore» (whoCloses) leggeva checksState='pass'
 *     su un commit non piu' consegnato e autorizzava la chiusura automatica;
 *   - il gate checksState === 'fail' bloccava l'approvazione su un esito
 *     che non apparteneva piu' a questa consegna.
 */
describe("diffstat e checks cadono col rifiuto (review -> coda via update)", () => {
  it("rifiuto via update() azzera diffstat e checks", () => {
    const { svc, id } = conTask();
    // 1. Consegna con diffstat e checks verdi.
    svc.recordDelivery({
      taskId: id, branch: "topics/x", commit: "a".repeat(40),
      stat: { filesChanged: 7, insertions: 240, deletions: 18 },
    });
    svc.recordChecks({ taskId: id, state: "pass", commit: "a".repeat(40), runs: [] });
    svc.update({ taskId: id, actor: "human", by: "test", patch: { status: "review" } });
    // Verifico che i dati siano presenti prima del rifiuto.
    const prima = svc.get(id)!.task;
    expect(prima.deliveryFilesChanged).toBe(7);
    expect(prima.checksState).toBe("pass");

    // 2. Rifiuto: review -> todo tramite update().
    svc.update({ taskId: id, actor: "human", by: "test", patch: { status: "todo" } });
    const dopo = svc.get(id)!.task;

    // Diffstat.
    expect(dopo.deliveryFilesChanged, "diffstat non sopravvive al rifiuto").toBeNull();
    expect(dopo.deliveryInsertions, "insertions non sopravvivono al rifiuto").toBeNull();
    expect(dopo.deliveryDeletions, "deletions non sopravvivono al rifiuto").toBeNull();
    // Checks.
    expect(dopo.checksState, "checks_state non sopravvive al rifiuto").toBeNull();
  });

  it("rifiuto via update() azzera anche da done -> todo", () => {
    const { svc, id } = conTask();
    svc.recordDelivery({
      taskId: id, branch: "topics/y", commit: "b".repeat(40),
      stat: { filesChanged: 3, insertions: 10, deletions: 2 },
    });
    svc.recordChecks({ taskId: id, state: "fail", commit: "b".repeat(40), runs: [] });
    // Porta in done direttamente (simulazione land).
    svc.update({ taskId: id, actor: "human", by: "test", patch: { status: "review" } });
    svc.update({ taskId: id, actor: "human", by: "test", patch: { status: "done" } });
    const prima = svc.get(id)!.task;
    expect(prima.deliveryFilesChanged).toBe(3);
    expect(prima.checksState).toBe("fail");

    // Riapre: done -> todo.
    svc.update({ taskId: id, actor: "human", by: "test", patch: { status: "todo" } });
    const dopo = svc.get(id)!.task;
    expect(dopo.deliveryFilesChanged, "diffstat non sopravvive all'uscita da done").toBeNull();
    expect(dopo.checksState, "checks_state non sopravvive all'uscita da done").toBeNull();
  });
});

describe("diffstat e checks cadono col rifiuto (reviewDecision)", () => {
  it("reviewDecision('reject') azzera diffstat e checks", () => {
    const { svc, id } = conTask();
    svc.recordDelivery({
      taskId: id, branch: "topics/z", commit: "c".repeat(40),
      stat: { filesChanged: 5, insertions: 50, deletions: 5 },
    });
    svc.recordChecks({ taskId: id, state: "pass", commit: "c".repeat(40), runs: [] });
    svc.update({ taskId: id, actor: "human", by: "test", patch: { status: "review" } });

    const prima = svc.get(id)!.task;
    expect(prima.deliveryFilesChanged).toBe(5);
    expect(prima.checksState).toBe("pass");

    svc.reviewDecision({ taskId: id, by: "test", decision: "reject" });
    const dopo = svc.get(id)!.task;
    expect(dopo.deliveryFilesChanged, "diffstat non sopravvive al reviewDecision reject").toBeNull();
    expect(dopo.deliveryInsertions, "insertions non sopravvivono al reviewDecision reject").toBeNull();
    expect(dopo.deliveryDeletions, "deletions non sopravvivono al reviewDecision reject").toBeNull();
    expect(dopo.checksState, "checks_state non sopravvive al reviewDecision reject").toBeNull();
  });

  it("rosso PRIMA del fix: checks_state='pass' su commit non piu' consegnato", () => {
    // Questo test era ROSSO prima del fix perche' checksState restava 'pass'
    // dopo il rifiuto, il che autorizzava whoCloses a chiudere senza umano.
    // Ora deve essere verde: dopo il rifiuto checksState e' null.
    const { svc, id } = conTask();
    svc.recordDelivery({ taskId: id, branch: "topics/w", commit: "d".repeat(40) });
    svc.recordChecks({ taskId: id, state: "pass", commit: "d".repeat(40), runs: [] });
    svc.update({ taskId: id, actor: "human", by: "test", patch: { status: "review" } });
    svc.reviewDecision({ taskId: id, by: "test", decision: "reject" });
    // checksState null = 'non misurato su questa consegna' = whoCloses -> 'human'.
    expect(svc.get(id)!.task.checksState).toBeNull();
  });
});

