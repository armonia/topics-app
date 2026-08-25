/**
 * L'ATTERRAGGIO, E CHI PUO' RIAPRIRE UNA CARD CHIUSA.
 *
 * `settleLanded` e il suo verdetto TESTIMONIATO — il punto in cui la board
 * smette di credere a un `ok` e va a guardare main — piu' l'uscita da `done`:
 * quale traccia resta sulla card, e chi ha il diritto di rimetterla in gioco.
 *
 * Separato da `tasks-delivery.test.ts` perche' e' un'altra domanda: li' «cosa ha
 * prodotto e come lo provo», qui «e' davvero su main, e cosa succede se torna
 * indietro». Banco di prova condiviso in `tasks-test-db.ts`.
 *
 * @covers LAND-05
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskService, TaskServiceError, type TaskService } from "./tasks";
import { freshDb, svc, PID } from "./tasks-test-db";

/**
 * L'esito di un land è un FATTO, e lo stato della card lo deve dire in ENTRAMBI
 * i versi. Misurato l'11/08: land fallito → card in `done` col codice fuori da
 * main; land riuscito → card `in_progress` con un agente sopra a rifarlo.
 */
describe("settleLanded / verdetto testimoniato", () => {
  let db: Database; let svc: TaskService;
  beforeEach(() => { db = freshDb(); svc = createTaskService(db); });

  const nuovo = (patch = "") => {
    const t = svc.create({ projectId: "pX", text: "feature" });
    if (patch) db.prepare(`UPDATE tasks SET ${patch} WHERE id = ?`).run(t.id);
    return t.id;
  };

  test("una card viva chiusa dal land: done, chip spento, e la riga di storico dice perché", () => {
    const id = nuovo("status = 'in_progress', dispatch_state = 'working'");
    const after = svc.settleLanded({ taskId: id, by: "system", reason: "il land è riuscito: il codice è su main" });
    expect(after?.status).toBe("done");
    // Il chip spento è ciò che toglie la card dalla presa del dispatcher.
    expect(after?.dispatchState).toBe(null);
    const ev = svc.get(id)!.comments.filter((c) => c.kind === "status").at(-1)!;
    expect(ev.author).toBe("system");
    expect(ev.content).toContain("il codice è su main");
  });

  test("su una card già chiusa e ferma non scrive NIENTE: nessuna riga done→done", () => {
    const id = nuovo("status = 'done'");
    const before = svc.get(id)!.comments.length;
    svc.settleLanded({ taskId: id, by: "system", reason: "x" });
    expect(svc.get(id)!.comments.length).toBe(before);
    expect(svc.get(id)!.task.status).toBe("done");
  });

  test("una card chiusa ma col chip ANCORA acceso si ripulisce, senza una nuova transizione", () => {
    // Il caso in mezzo: `done` con `dispatch_state` vivo è claimabile-adiacente
    // e mostra un chip che mente. Si spegne, ma la card non è "ri-chiusa".
    const id = nuovo("status = 'done', dispatch_state = 'working'");
    const before = svc.get(id)!.comments.filter((c) => c.kind === "status").length;
    const after = svc.settleLanded({ taskId: id, by: "system", reason: "x" });
    expect(after?.dispatchState).toBe(null);
    expect(svc.get(id)!.comments.filter((c) => c.kind === "status").length).toBe(before);
  });

  test("chiudere è chiudere: la card non resta «riaperta» sopra un done, e dice CHI l'ha chiusa", () => {
    // Questa porta scrive `done` a SQL grezzo: senza le due colonne messe a mano
    // resterebbe `reopened_actor` acceso e `done_actor` vuoto, cioè «riaperta da
    // umano» stampato sopra una card chiusa. Uno stato che `update()` non
    // produce mai.
    const id = nuovo("status = 'in_progress', dispatch_state = 'working'");
    db.prepare("UPDATE tasks SET reopened_at = '2026-08-12T00:00:00Z', reopened_by = 'umano', reopened_actor = 'human' WHERE id = ?").run(id);

    const dopo = svc.settleLanded({ taskId: id, by: "system", reason: "il land è riuscito" })!;

    expect(dopo.status).toBe("done");
    expect(dopo.reopenedActor).toBeNull();
    expect(dopo.reopenedAt).toBeNull();
    expect(dopo.reopenedBy).toBeNull();
    expect(dopo.doneActor).toBe("system");
  });

  test("un verdetto umano NON si riscrive a nome del sistema", () => {
    // La controprova del COALESCE: se una persona aveva già chiuso questa card,
    // il verdetto è suo. Sovrascriverlo sarebbe la stessa bugia al contrario.
    const id = nuovo("status = 'done', dispatch_state = 'working', done_actor = 'human'");
    const dopo = svc.settleLanded({ taskId: id, by: "system", reason: "il land è riuscito" })!;
    expect(dopo.doneActor).toBe("human");
  });

  /**
   * IL LAND NON CHIUDE UN PADRE CON STEP APERTI.
   *
   * `settleLanded` era l'unica porta verso `done` che saltasse l'invariante:
   * scrive SQL grezzo, quindi il cancello di `update()` e dell'approvazione non
   * la incontrava. «Landa su main» chiudeva il padre e i suoi passi restavano
   * appesi sotto una card chiusa — fuori dalle colonne (il feed è `rootsOnly`),
   * fuori dalla presa del dispatcher (uno step non lo claima nessuno), cioè
   * lavoro irraggiungibile.
   */
  test("un padre con step aperti NON si chiude col land, ma il chip si spegne lo stesso", () => {
    const padre = nuovo("status = 'review', dispatch_state = 'working', dispatch_deferred_until = '2099-01-01T00:00:00Z'");
    const figlio = svc.create({ projectId: "pX", text: "passo aperto", parentTaskId: padre });

    const dopo = svc.settleLanded({ taskId: padre, by: "system", reason: "il land è riuscito" })!;

    expect(dopo.status).toBe("review");   // resta dov'era: il merge non la chiude
    expect(svc.get(figlio.id)!.task.status).not.toBe("done");
    // Il merge però è avvenuto: la card non deve restare claimabile, o un agente
    // riparte a rifare ciò che sta su main.
    expect(dopo.dispatchState).toBeNull();
    expect(dopo.dispatchDeferredUntil).toBeNull();
    // E nessuna riga di storico per una transizione che non c'è stata.
    expect(svc.get(padre)!.comments.filter((c) => c.kind === "status")).toEqual([]);
  });

  test("chiuso l'ultimo step, lo stesso land chiude il padre", () => {
    // La controprova: senza di questa il cancello sopra potrebbe essere «non
    // chiude mai» e passerebbe uguale.
    const padre = nuovo("status = 'review', dispatch_state = 'working'");
    const figlio = svc.create({ projectId: "pX", text: "passo", parentTaskId: padre });
    svc.update({ taskId: figlio.id, actor: "human", by: "umano", patch: { status: "done" } });

    expect(svc.settleLanded({ taskId: padre, by: "system", reason: "il land è riuscito" })!.status).toBe("done");
  });

  test("un ATTERRAGGIO testimoniato esce dai candidati della passata: non lo si rideduce", () => {
    const dedotto = nuovo();
    const visto = nuovo();
    for (const id of [dedotto, visto]) {
      svc.recordDelivery({ taskId: id, branch: "topics/x", commit: "c".repeat(40) });
      db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
    }
    svc.recordLandingState({ taskId: dedotto, state: "unlanded", checkedAt: "2026-08-11T00:00:00Z" });
    svc.recordLandingState({ taskId: visto, state: "landed", checkedAt: "2026-08-11T00:00:00Z", witnessed: true });

    const candidati = svc.listLandingAuditCandidates().map((c) => c.id);
    expect(candidati).toContain(dedotto);   // dedotto: si può riprovare
    expect(candidati).not.toContain(visto); // visto: non c'è niente da aggiungere
  });

  /**
   * L'ALTRA METÀ DELLA TESTIMONIANZA, e non è simmetrica.
   *
   * «È atterrato» è un fatto che non scade: quel contenuto su main ci resta.
   * «NON è atterrato» è un fatto su un ISTANTE — il land che non è riuscito — e
   * il giorno dopo qualcuno può aver cherry-piccato quel lavoro a mano. Tenendo
   * fuori dall'audit anche questo verdetto, l'accusa si congelava: misurate il
   * 13/08 due card in Done che dicevano «non su main» con il commit di consegna
   * ANTENATO di main.
   */
  test("un MANCATO atterraggio testimoniato torna fra i candidati: il mondo va avanti", () => {
    const id = nuovo();
    svc.recordDelivery({ taskId: id, branch: "topics/x", commit: "d".repeat(40) });
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
    svc.recordLandingState({ taskId: id, state: "unlanded", checkedAt: "2026-08-11T00:00:00Z", witnessed: true });

    expect(svc.listLandingAuditCandidates().map((c) => c.id)).toContain(id);
    // La testimonianza resta, ed è giusto: dice ancora CHI ha risposto. A
    // cadere è solo l'esenzione dal ricontrollo.
    expect(atterraggio(id).w).toBe(1);
  });

  /**
   * A BRANCH IS A DELIVERY TOO, and the audit was blind to it.
   *
   * `debtVerdict` asks the branch FIRST (`classifyBranchLanding`) and only
   * falls back to the commit once the branch is gone — so the verdict logic
   * could always answer for a card carrying just a branch. The candidate query
   * never asked it: it wanted a commit.
   *
   * Measured on this board on 2026-08-21: 27 done cards with a branch and no
   * commit, invisible to the audit for their whole life. By the time anyone
   * looked, none of the first twelve branches was still alive and exactly one
   * merge could be found on main — the evidence had evaporated. What this test
   * defends is not those cards; it is that the next one gets asked WHILE its
   * branch exists.
   */
  test("una consegna col SOLO ramo entra fra i candidati", () => {
    const id = nuovo();
    svc.recordDelivery({ taskId: id, branch: "topics/solo-ramo", commit: null });
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);

    const riga = db.prepare("SELECT delivery_branch AS b, delivery_commit AS c FROM tasks WHERE id = ?").get(id) as { b: string | null; c: string | null };
    // If this one falls, the red is about the SETUP: with no branch and no
    // commit the card is not the case this test measures.
    expect(riga.b).toBe("topics/solo-ramo");
    expect(riga.c ?? null).toBeNull();

    const c = svc.listLandingAuditCandidates().find((x) => x.id === id);
    expect(c).toBeTruthy();
    // And the branch reaches whoever has to ask it: without that the candidate
    // would arrive mute and the pass would fall back to a commit that is not
    // there.
    expect(c!.deliveryBranch).toBe("topics/solo-ramo");
  });

  test("senza NESSUNA consegna la card resta fuori: non c'e' niente da chiedere", () => {
    const id = nuovo();
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
    expect(svc.listLandingAuditCandidates().map((x) => x.id)).not.toContain(id);
  });

  test("un ramo VUOTO non e' una consegna", () => {
    const id = nuovo();
    db.prepare("UPDATE tasks SET status = 'done', delivery_branch = '' WHERE id = ?").run(id);
    expect(svc.listLandingAuditCandidates().map((x) => x.id)).not.toContain(id);
  });

  test("una CONSEGNA nuova fa cadere la testimonianza: era su un'altra consegna", () => {
    const id = nuovo();
    svc.recordDelivery({ taskId: id, branch: "topics/x", commit: "a".repeat(40) });
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
    svc.recordLandingState({ taskId: id, state: "landed", checkedAt: "2026-08-11T00:00:00Z", witnessed: true });
    expect(svc.listLandingAuditCandidates().map((c) => c.id)).not.toContain(id);

    svc.recordDelivery({ taskId: id, branch: "topics/x", commit: "b".repeat(40) });
    expect(svc.listLandingAuditCandidates().map((c) => c.id)).toContain(id);
  });

  /**
   * L'ACCUSA CHE NON POTEVA PIÙ ESSERE RITIRATA.
   *
   * `markLandPending` timbra `unlanded` quando il land viene CHIESTO, e il suo
   * commento dice che la passata periodica «resta libera di correggerlo». Non lo
   * era: il filtro `delivery_commit IS NOT NULL` teneva fuori dai candidati
   * proprio le card senza commit, cioè quelle su cui quel timbro resta l'unica
   * cosa scritta. Misurate il 18/08 sulla board di topics-app: 13 card in
   * review/done dicevano «non è su main» senza consegna registrata, la più
   * vecchia da sei giorni, e due di loro erano su main con tanto di merge.
   *
   * Il filtro serve ancora, e resta: senza consegna non c'è niente da VERIFICARE.
   * Ma un'accusa in piedi è qualcosa da RITIRARE, ed è lavoro dell'audit.
   */
  test("una card senza consegna che porta un'accusa torna fra i candidati", () => {
    const accusata = nuovo("status = 'done', delivery_branch = 'topics/potato'");
    svc.recordLandingState({ taskId: accusata, state: "unlanded", checkedAt: "2026-08-13T00:00:00Z" });

    expect(svc.listLandingAuditCandidates().map((c) => c.id)).toContain(accusata);
    // E ci arriva con l'unico indirizzo che le resta, o l'audit non saprebbe
    // dove guardare.
    const riga = svc.listLandingAuditCandidates().find((c) => c.id === accusata)!;
    expect(riga.deliveryBranch).toBe("topics/potato");
    expect(riga.deliveryCommit).toBeNull();
  });

  test("una card senza consegna e senza accusa resta fuori: non c'è niente da dire", () => {
    const muta = nuovo("status = 'done'");
    const assolta = nuovo("status = 'done'");
    svc.recordLandingState({ taskId: assolta, state: "unverifiable", checkedAt: "2026-08-13T00:00:00Z" });

    const candidati = svc.listLandingAuditCandidates().map((c) => c.id);
    expect(candidati).not.toContain(muta);
    expect(candidati).not.toContain(assolta);
  });

  /**
   * Lo scatto della consegna descrive un lavoro CONSEGNATO. Una card che rientra
   * in coda non lo sta più consegnando: o è stata rifiutata, o qualcuno l'ha
   * riaperta per chiedere dell'altro. Tenerlo la fa parlare di un frutto che non
   * è più suo — e il dispatcher su quel campo ci CHIUDE la card («è già su main»),
   * quindi la richiesta nuova morirebbe sul commit vecchio senza via d'uscita:
   * solo una consegna nuova riscrive quel campo, e per consegnare serve il
   * dispatch che il cancello blocca.
   */
  const conConsegna = (stato: string) => {
    const id = nuovo();
    svc.recordDelivery({ taskId: id, branch: "topics/x", commit: "a".repeat(40) });
    svc.recordLandingState({ taskId: id, state: "landed", checkedAt: "2026-08-12T00:00:00Z", witnessed: true });
    db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(stato, id);
    return id;
  };
  const atterraggio = (id: string) =>
    db.prepare("SELECT landing_state AS s, landing_checked_at AS c, landing_witnessed AS w FROM tasks WHERE id = ?").get(id) as any;

  test("una card riaperta da done torna in coda SENZA la consegna di prima", () => {
    const id = conConsegna("done");
    expect(svc.get(id)!.task.deliveryCommit).toBe("a".repeat(40));

    const dopo = svc.update({ taskId: id, actor: "human", by: "umano", patch: { status: "todo" } });

    expect(dopo.deliveryCommit).toBeNull();
    expect(dopo.deliveryBranch).toBeNull();
    // Il verdetto sull'atterraggio cade col suo commit: senza, il prossimo
    // giudizio nascerebbe già «visto» su una consegna che non esiste più.
    expect(atterraggio(id)).toEqual({ s: null, c: null, w: 0 });
  });

  test("stessa cosa uscendo da review: un rifiuto non lascia in mano il frutto rifiutato", () => {
    // La stessa strada di `done`, da un'altra porta: chi trascina una card da
    // Review a Todo sta chiedendo di rifarla, esattamente come chi la riapre.
    const id = conConsegna("review");
    const dopo = svc.update({ taskId: id, actor: "human", by: "umano", patch: { status: "todo" } });
    expect(dopo.deliveryCommit).toBeNull();
    expect(atterraggio(id).w).toBe(0);
  });

  test("verso done e verso review lo scatto RESTA: è ciò che il reviewer guarda", () => {
    // La controprova, e non è pedanteria: azzerare qui cancellerebbe la sola
    // descrizione di ciò che è stato approvato, cioè quello che il land legge.
    const inReview = conConsegna("review");
    const approvata = svc.update({ taskId: inReview, actor: "human", by: "umano", patch: { status: "done" } });
    expect(approvata.deliveryCommit).toBe("a".repeat(40));
    expect(atterraggio(inReview).w).toBe(1);

    const chiusa = conConsegna("done");
    const riletta = svc.update({ taskId: chiusa, actor: "human", by: "umano", patch: { status: "review" } });
    expect(riletta.deliveryCommit).toBe("a".repeat(40));
  });

  test("una card che non è mai stata consegnata non perde niente: il campo era già vuoto", () => {
    const id = nuovo("status = 'done'");
    const dopo = svc.update({ taskId: id, actor: "human", by: "umano", patch: { status: "todo" } });
    expect(dopo.deliveryCommit).toBeNull();
    expect(dopo.status).toBe("todo");
  });
});

// L'11/08, segnalato dal proprietario della board: «avevo visto il task fatto
// nella tab kanban, ora non lo vedo più». Misurato: undici card uscite da `done`
// in sei ore, nessuna persa — ma la board non lo diceva. Il motivo viveva nel
// thread; chi guarda la colonna vedeva un buco. Due fatti sulla card, entrambi
// leggibili dall'API della board: chi ha chiuso (`doneActor`) e che è stata
// riaperta (`reopened*`).
describe("uscita da done: la traccia sulla card e chi può riaprirla", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  /** Una card chiusa da un UMANO che approva la review: il caso segnalato. */
  function doneByHuman(): string {
    const t = s.create({ projectId: PID, text: "consegna", status: "in_progress" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto, guarda demo/" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    s.reviewDecision({ taskId: t.id, by: "umano", decision: "approve" });
    return t.id;
  }

  /** Una card `done` senza passare da una review: `create` rifiuta `done` diretto. */
  function doneByDrag(text: string): { id: string } {
    const t = s.create({ projectId: PID, text, status: "review" });
    s.update({ taskId: t.id, actor: "human", by: "umano", patch: { status: "done" } });
    return { id: t.id };
  }

  test("chi ha chiuso resta scritto: approvazione umana → 'human', step chiuso dall'agent → 'agent'", () => {
    const approved = doneByHuman();
    expect(s.get(approved)!.task.doneActor).toBe("human");

    // Lo step di checklist di un agent: lo chiude lui, non passa da una review.
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const root = s.create({ projectId: PID, text: "task dell'agent", status: "in_progress" });
    s.bindTopic({ taskId: root.id, topicId: "top-1" });
    const step = s.create({ projectId: PID, text: "passo 1", parentTaskId: root.id });
    s.update({ taskId: step.id, actor: "agent", by: "claude", patch: { status: "done" }, agentTopicId: "top-1" });
    expect(s.get(step.id)!.task.doneActor).toBe("agent");
  });

  test("una card che esce da done lo DICE sulla card: reopenedAt/By/Actor, leggibili da get e list", () => {
    const id = doneByHuman();
    const before = s.get(id)!.task;
    expect(before.reopenedAt).toBeNull();

    s.update({ taskId: id, actor: "human", by: "umano", patch: { status: "in_progress" } });

    const after = s.get(id)!.task;
    expect(after.status).toBe("in_progress");
    expect(after.reopenedAt).not.toBeNull();
    expect(after.reopenedBy).toBe("umano");
    expect(after.reopenedActor).toBe("human");
    // …e sulla LISTA della board, che è ciò che disegna la colonna.
    const listed = s.list({ scope: "project", projectId: PID }).find((t) => t.id === id)!;
    expect(listed.reopenedAt).toBe(after.reopenedAt);
    expect(listed.reopenedBy).toBe("umano");
    // Chiudere il ciclo azzera il segno: una card di nuovo `done` non è «riaperta».
    s.update({ taskId: id, actor: "human", by: "umano", patch: { status: "done" } });
    const redone = s.get(id)!.task;
    expect(redone.reopenedAt).toBeNull();
    expect(redone.reopenedBy).toBeNull();
    expect(redone.doneActor).toBe("human");
  });

  test("un agent NON riapre un done deciso da un umano (approvazione o trascinamento)", () => {
    const approved = doneByHuman();
    expect(() => s.update({ taskId: approved, actor: "agent", by: "claude", patch: { status: "in_progress" } }))
      .toThrow(/decisione umana/);
    expect(s.get(approved)!.task.status).toBe("done"); // la card non si è mossa
    expect(s.get(approved)!.task.reopenedAt).toBeNull(); // e nessuna traccia falsa

    // Stessa cosa per un done messo a mano trascinando sulla board.
    const dragged = s.create({ projectId: PID, text: "chiusa a mano", status: "review" });
    s.update({ taskId: dragged.id, actor: "human", by: "umano", patch: { status: "done" } });
    expect(() => s.update({ taskId: dragged.id, actor: "agent", by: "claude", patch: { status: "todo" } }))
      .toThrow(/decisione umana/);

    // L'umano invece riapre sempre: il cancello è sull'agent, non sulla board.
    expect(s.update({ taskId: approved, actor: "human", by: "umano", patch: { status: "review" } }).status).toBe("review");
  });

  test("il proprio sottotask, chiuso dall'agent e mai passato da una review, resta riapribile", () => {
    db.run("INSERT INTO topics (id) VALUES ('top-2')");
    const root = s.create({ projectId: PID, text: "task dell'agent", status: "in_progress" });
    s.bindTopic({ taskId: root.id, topicId: "top-2" });
    const step = s.create({ projectId: PID, text: "passo 1", parentTaskId: root.id });
    s.update({ taskId: step.id, actor: "agent", by: "claude", patch: { status: "done" }, agentTopicId: "top-2" });

    const back = s.update({ taskId: step.id, actor: "agent", by: "claude", patch: { status: "in_progress" }, agentTopicId: "top-2" });
    expect(back.status).toBe("in_progress");
    // Anche questa riapertura lascia il segno: è comunque una cosa fatta che sparisce.
    expect(back.reopenedActor).toBe("agent");
    expect(back.reopenedBy).toBe("claude");
  });

  test("storico senza prova (done_actor NULL): l'agent la riapre, e la traccia si scrive lo stesso", () => {
    // Le card chiuse PRIMA della migration che non portano un'approvazione
    // approvata restano «non si sa». Il cancello le lascia passare di proposito:
    // murare a posteriori bloccherebbe proprio i sottotask che gli agenti
    // chiudono da soli. Ciò che NON si perde è il segno — questo è il punto
    // della card, e vale anche qui.
    const legacy = doneByDrag("chiusa nel 2025");
    db.run("UPDATE tasks SET done_actor = NULL WHERE id = ?", [legacy.id]);

    const back = s.update({ taskId: legacy.id, actor: "agent", by: "claude", patch: { status: "todo" } });
    expect(back.status).toBe("todo");
    expect(back.reopenedActor).toBe("agent");
    expect(back.reopenedAt).not.toBeNull();
  });

  test("anche le porte di SISTEMA lasciano il segno: requeue, attesa dichiarata, consegna forzata", () => {
    // Non passano da `update()` — scrivono lo status a SQL grezzo. Erano tre
    // modi di far uscire una card da `done` senza che la board lo dicesse.
    const requeued = doneByDrag("rimessa in coda");
    s.release({ taskId: requeued.id, requeue: true, reason: "server ripartito", by: "dispatcher" });
    const r = s.get(requeued.id)!.task;
    expect(r.status).toBe("todo");
    expect(r.reopenedActor).toBe("system");
    expect(r.reopenedAt).not.toBeNull();
    expect(r.doneActor).toBeNull();

    const waiting = doneByDrag("in attesa");
    s.deferForWait({ taskId: waiting.id, reason: "aspetto il server", minutes: 5, by: "claude" });
    expect(s.get(waiting.id)!.task.reopenedActor).toBe("agent");

    const forced = doneByDrag("consegna di sistema");
    s.deliverToReviewBySystem({ taskId: forced.id, reason: "tentativi esauriti", cause: "retries_exhausted" });
    const f = s.get(forced.id)!.task;
    expect(f.status).toBe("review");
    expect(f.reopenedActor).toBe("system");
    expect(f.reopenedBy).toBe("dispatcher");
  });

  test("il ritiro della MACCHINA non si firma «da te»: attore = permesso, firma = chi", () => {
    // Il land in conflitto (routes/tasks.ts, ramo "conflict") ritira la card da
    // `done` con `actor: "human"` — è l'asse dei PERMESSI, l'unico che può
    // riportare indietro una card chiusa — ma `by: "system"`. Leggendo l'attore,
    // il chip avrebbe detto «riaperta da te» di una cosa che l'umano non ha
    // deciso: la stessa bugia che questa card toglie, un livello più giù.
    const landata = doneByDrag("consegna landata");
    const back = s.update({
      taskId: landata.id, actor: "human", by: "system",
      patch: { status: "in_progress" }, statusReason: "il land ha fatto conflitto con main",
    });
    expect(back.reopenedActor).toBe("system");
    expect(back.reopenedBy).toBe("system");
  });

  test("una card che NON era done non prende una traccia falsa da nessuna porta", () => {
    const vivo = s.create({ projectId: PID, text: "mai chiusa", status: "in_progress" });
    s.update({ taskId: vivo.id, actor: "human", by: "umano", patch: { status: "todo" } });
    expect(s.get(vivo.id)!.task.reopenedAt).toBeNull();
    s.release({ taskId: vivo.id, requeue: false, by: "dispatcher" });
    expect(s.get(vivo.id)!.task.reopenedAt).toBeNull();
    s.deliverToReviewBySystem({ taskId: vivo.id, reason: "boh", cause: "retries_exhausted" });
    expect(s.get(vivo.id)!.task.reopenedAt).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // USCIRE DA REVIEW VALE QUANTO USCIRE DA DONE
  //
  // Il 12/08 alle 18:26 è arrivato un cambio di rotta, con la card trascinata
  // `d6baaf5e` da `review` a `in corso`. Il segno di riapertura si accendeva
  // solo uscendo da `done`, quindi per il campo nessuno aveva riaperto niente:
  // il mattino dopo la chiusura automatica del dispatcher ha chiuso la card
  // sopra la consegna di CINQUE GIORNI prima, e la richiesta è finita
  // archiviata dentro una card `done`. Il segnale non può dipendere da quale
  // casella ha attraversato il dito.
  // ───────────────────────────────────────────────────────────────────────────

  /** Una card in review con una consegna registrata: lo stato di `d6baaf5e`. */
  function inReviewConConsegna(text: string): string {
    const t = s.create({ projectId: PID, text, status: "in_progress" });
    s.addComment({ taskId: t.id, author: "claude", content: "consegnato" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    s.recordDelivery({ taskId: t.id, branch: "topics/x", commit: "f".repeat(40) });
    return t.id;
  }

  test.each(["in_progress", "todo", "backlog"] as const)(
    "trascinata da review a %s: è una riapertura umana, e la consegna vecchia non la segue",
    (destinazione: "in_progress" | "todo" | "backlog") => {
      const id = inReviewConConsegna(`review → ${destinazione}`);
      expect(s.get(id)!.task.deliveryCommit).not.toBeNull();

      s.update({ taskId: id, actor: "human", by: "umano", patch: { status: destinazione } });

      const after = s.get(id)!.task;
      expect(after.status).toBe(destinazione);
      expect(after.reopenedActor).toBe("human");
      expect(after.reopenedBy).toBe("umano");
      expect(after.reopenedAt).not.toBeNull();
      expect(after.deliveryCommit).toBeNull();
    },
  );

  test("il rifiuto in review lascia lo stesso segno: è la quarta uscita umana", () => {
    const id = inReviewConConsegna("rifiutata");
    // Un commento umano su una card in review arriva qui come reject-con-testo
    // (routes/tasks.ts): è LA porta da cui si è passati alle 18:25.
    const rejected = s.reviewDecision({ taskId: id, by: "umano", decision: "reject", comment: "cambia rotta" });
    expect(rejected.status).toBe("in_progress");

    const after = s.get(id)!.task;
    expect(after.reopenedActor).toBe("human");
    expect(after.reopenedBy).toBe("umano");
    expect(after.deliveryCommit).toBeNull();
    expect(after.landingState).toBeNull();
  });

  test("uscire da review non spegne un done_actor che quel salto non tocca", () => {
    // `done_actor` racconta chi ha CHIUSO. Una card in review non ne ha uno, e
    // azzerarlo da qui riscriverebbe una decisione presa da un'altra parte.
    const id = doneByHuman();
    expect(s.get(id)!.task.doneActor).toBe("human");
    s.update({ taskId: id, actor: "human", by: "umano", patch: { status: "review" } });
    expect(s.get(id)!.task.doneActor).toBeNull(); // uscita da done: quello sì

    s.update({ taskId: id, actor: "human", by: "umano", patch: { status: "done" } });
    s.update({ taskId: id, actor: "human", by: "umano", patch: { status: "review" } });
    db.run("UPDATE tasks SET done_actor = 'human' WHERE id = ?", [id]);
    s.update({ taskId: id, actor: "human", by: "umano", patch: { status: "todo" } });
    expect(s.get(id)!.task.doneActor).toBe("human"); // review → todo non lo tocca
  });

  test("consegnare di nuovo chiude il ciclo: rientrare in review spegne il segno", () => {
    const id = inReviewConConsegna("riconsegnata");
    s.update({ taskId: id, actor: "human", by: "umano", patch: { status: "in_progress" } });
    expect(s.get(id)!.task.reopenedActor).toBe("human");

    s.addComment({ taskId: id, author: "claude", content: "rifatto" });
    s.update({ taskId: id, actor: "agent", by: "claude", patch: { status: "review" } });
    // Il rientro non riaccende il segno su sé stesso…
    expect(s.get(id)!.task.reopenedActor).toBe("human");
    s.reviewDecision({ taskId: id, by: "umano", decision: "approve" });
    // …e l'approvazione lo spegne: il ciclo si è chiuso.
    expect(s.get(id)!.task.reopenedAt).toBeNull();
  });

  test("un rientro in coda deciso dalla MACCHINA non si firma «umano» e tiene la consegna", () => {
    // È l'altro errore, e costa quanto il primo: la chiusura automatica esiste
    // proprio per riconoscere il lavoro già atterrato quando una card rientra da
    // sola (orfana rilasciata). Cancellarle il commit sotto le mani la
    // spegnerebbe su tutte le strade della macchina.
    const id = inReviewConConsegna("orfana rilasciata");
    s.release({ taskId: id, requeue: true, reason: "server ripartito", by: "dispatcher" });
    const after = s.get(id)!.task;
    expect(after.status).toBe("todo");
    expect(after.reopenedActor).toBe("system");
    expect(after.deliveryCommit).not.toBeNull();
  });
});
