/**
 * LA CONSEGNA E LA SUA PROVA.
 *
 * Chi ha portato la card in review e perche' (`deliveredBy`), l'esito dei checks
 * pre-review, e l'anteprima — promossa dal commento di consegna, col suo gate di
 * forma e il ramo diagramma. Tutto cio' che deve esserci PRIMA che un umano
 * possa decidere guardando la colonna.
 *
 * L'atterraggio e' l'altra meta' e sta in `tasks-landing.test.ts`: «e' su main,
 * e chi puo' riaprirlo» e' una domanda diversa da «cosa ha prodotto e come lo
 * provo». Banco di prova condiviso in `tasks-test-db.ts`.
 *
 * Nate il 18/08 dallo spacco di `tasks.test.ts` (3.378 righe, oltre il cancello
 * di dimensione). Il taglio segue le giunture che c'erano gia': nessun test e'
 * stato riscritto, e il conto prima/dopo e' identico — 229 test, 693 asserzioni.
 * @covers KANBAN-05
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskService, TaskServiceError, type TaskService } from "./tasks";
import { freshDb, svc, PID } from "./tasks-test-db";
import { isDeliverySheetPath } from "../../shared/media-kind";

/**
 * 1.3 — in colonna Review una consegna dell'agente e un task che il sistema ha
 * portato lì a fine turno avevano lo stesso aspetto. Sono due domande diverse:
 * nella prima c'è un deliverable, nella seconda può non esserci niente.
 */
describe("deliveredBy (chi ha portato il task in review)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  /** Agente pronto alla consegna: il gate del sommario vuole un commento suo. */
  function readyForDelivery() {
    const t = s.create({ projectId: PID, text: "x" });
    s.addComment({ taskId: t.id, author: "agent-1", content: "fatto, guarda demo/" });
    return t;
  }

  test("un task nasce senza consegna", () => {
    const t = s.create({ projectId: PID, text: "x" });
    expect(t.deliveredBy).toBeNull();
    expect(t.deliveredReason).toBeNull();
  });

  test("l'agente che consegna si firma", () => {
    const t = readyForDelivery();
    const rev = s.update({ taskId: t.id, actor: "agent", by: "agent-1", patch: { status: "review" } });
    expect(rev.deliveredBy).toBe("agent");
    expect(rev.deliveredReason).toBeNull();
  });

  test("l'umano che trascina in review non è l'agente", () => {
    const t = s.create({ projectId: PID, text: "x" });
    expect(s.update({ taskId: t.id, actor: "human", by: "u", patch: { status: "review" } }).deliveredBy).toBe("human");
  });

  test("il sistema si firma 'system' e dice PERCHÉ", () => {
    const t = s.create({ projectId: PID, text: "x" });
    const d = s.deliverToReviewBySystem({ taskId: t.id, reason: "budget finito", cause: "retries_exhausted" });
    expect(d.status).toBe("review");
    expect(d.deliveredBy).toBe("system");
    expect(d.deliveredReason).toBe("retries_exhausted");
    // Le due cause restano distinte: si decide diversamente nei due casi.
    const t2 = s.create({ projectId: PID, text: "y" });
    expect(s.deliverToReviewBySystem({ taskId: t2.id, reason: "rifiuto", cause: "model_refused" }).deliveredReason).toBe("model_refused");
  });

  test("un padre con sottotask aperti torna in CODA, non in review", () => {
    // In review sarebbe una card su cui l'umano non puo' decidere niente (il
    // gate su `done` rifiuta un padre con figli attivi) e ci tornerebbe a ogni
    // turno esaurito. Misurato il 10/08: quattro rimbalzi in un'ora.
    const p = s.create({ projectId: PID, text: "epic" });
    const kid = s.create({ projectId: PID, text: "passo aperto", parentTaskId: p.id });
    // «Aperto» vuol dire che qualcuno lo sta lavorando o sta per farlo: in coda.
    // Un figlio lasciato in backlog è parcheggiato e non blocca (test qui sotto).
    s.update({ taskId: kid.id, actor: "human", by: "u", patch: { status: "todo" } });
    const d = s.deliverToReviewBySystem({ taskId: p.id, reason: "budget finito", cause: "retries_exhausted" });
    expect(d.status).toBe("todo");
    // La ragione resta scritta nel thread: sparire in silenzio sarebbe peggio.
    const thread = s.get(p.id)!.comments.filter((c) => c.author === "system");
    expect(thread.some((c) => c.content.includes("budget finito"))).toBe(true);
  });

  test("la mossa «valuta cosa ha prodotto» NON finisce su una card mandata in coda", () => {
    // Il difetto, misurato il 18/08 su `171b787d`: la nota veniva scritta come
    // primo atto, PRIMA delle due guardie che possono mandare la card in `todo`.
    // Commento alle 03:34:43.585, riga di stato `in_progress→todo` alle
    // 03:34:43.587 — due millisecondi dopo. Su tre giorni: 35 note di questa
    // famiglia, 29 seguite da review e SEI da todo. La riga resta nel thread per
    // sempre, e quando la card arriva DAVVERO in review è quella che il reviewer
    // trova: gli chiede di valutare una consegna che allora non esisteva.
    const p = s.create({ projectId: PID, text: "epic" });
    const kid = s.create({ projectId: PID, text: "passo aperto", parentTaskId: p.id });
    s.update({ taskId: kid.id, actor: "human", by: "u", patch: { status: "todo" } });
    const d = s.deliverToReviewBySystem({
      taskId: p.id, reason: "budget finito", cause: "retries_exhausted",
      nextMove: "L'ho portato io in review: valuta cosa ha prodotto.",
    });
    expect(d.status).toBe("todo");
    const testi = s.get(p.id)!.comments.filter((c) => c.author === "system").map((c) => c.content).join("\n");
    // Il PERCHE' resta: sparire in silenzio sarebbe peggio.
    expect(testi).toContain("budget finito");
    // Il DOVE no, perché è falso.
    expect(testi).not.toContain("valuta cosa ha prodotto");
    // E la card dice dove è andata davvero.
    expect(testi).toContain("In attesa dei sottotask");
  });

  test("la mossa arriva invece sulla card che finisce DAVVERO in review", () => {
    // Il controllo del test qui sopra: separare il dove dal perché non deve
    // diventare «la mossa non si scrive mai», che lascerebbe il reviewer senza
    // la sola frase che gli dice cosa può fare.
    const p = s.create({ projectId: PID, text: "solo" });
    const d = s.deliverToReviewBySystem({
      taskId: p.id, reason: "budget finito", cause: "retries_exhausted",
      nextMove: "L'ho portato io in review: valuta cosa ha prodotto.",
    });
    expect(d.status).toBe("review");
    const testi = s.get(p.id)!.comments.filter((c) => c.author === "system").map((c) => c.content).join("\n");
    expect(testi).toContain("budget finito");
    expect(testi).toContain("valuta cosa ha prodotto");
  });

  test("un padre coi figli TUTTI chiusi consegna in review come chiunque altro", () => {
    // Il controllo del test qui sopra: il rinvio in coda non deve diventare
    // "un padre non consegna mai".
    const p = s.create({ projectId: PID, text: "epic" });
    const kid = s.create({ projectId: PID, text: "passo", parentTaskId: p.id });
    s.update({ taskId: kid.id, actor: "human", by: "u", patch: { status: "done" } });
    expect(s.deliverToReviewBySystem({ taskId: p.id, reason: "fine", cause: "retries_exhausted" }).status).toBe("review");
  });

  test("figli SOLO parcheggiati: non è un'attesa, è una DOMANDA — e la fa", () => {
    // Nessuno dispaccia dal backlog: rimandare il padre in coda lo farebbe
    // girare ogni 10 minuti per sempre (misurati 20 padri così l'11/08). Ma
    // parcheggiare anche lui lo nascondeva nella colonna del riposo (cinque card
    // ferme il 12/08, nessuna lo diceva): la card va dove si vedono le domande,
    // con le due risposte possibili. Il resto in `tasks.parked-stall.test.ts`.
    const p = s.create({ projectId: PID, text: "epic" });
    s.create({ projectId: PID, text: "seguito rimandato", parentTaskId: p.id });
    const d = s.deliverToReviewBySystem({ taskId: p.id, reason: "fine" });
    expect(d.status).toBe("review");
    expect(d.dispatchState).toBe("needs_input");
    expect(d.deliveredReason).toBe("parked_children");
    const notes = s.get(p.id)!.comments.map((c) => c.content).join("\n");
    expect(notes).toContain("seguito rimandato");
  });

  test("senza causa nota resta 'system' e basta — mai una causa inventata", () => {
    const t = s.create({ projectId: PID, text: "x" });
    const d = s.deliverToReviewBySystem({ taskId: t.id, reason: "boh" });
    expect(d.deliveredBy).toBe("system");
    expect(d.deliveredReason).toBeNull();
  });

  test("consegna vera DOPO una di sistema: la causa se ne va con la firma", () => {
    const t = readyForDelivery();
    s.deliverToReviewBySystem({ taskId: t.id, reason: "budget finito", cause: "retries_exhausted" });
    // Rifiutato → l'agent riparte → questa volta consegna lui.
    s.reviewDecision({ taskId: t.id, by: "u", decision: "reject" });
    s.addComment({ taskId: t.id, author: "agent-1", content: "ora sì" });
    const again = s.update({ taskId: t.id, actor: "agent", by: "agent-1", patch: { status: "review" } });
    expect(again.deliveredBy).toBe("agent");
    // Una causa di sistema rimasta appiccicata direbbe "non l'ha consegnato
    // l'agent" su una consegna dell'agent.
    expect(again.deliveredReason).toBeNull();
  });

  test("la firma sopravvive all'approvazione: su done resta scritto com'è arrivato", () => {
    const t = s.create({ projectId: PID, text: "x" });
    s.deliverToReviewBySystem({ taskId: t.id, reason: "budget finito", cause: "retries_exhausted" });
    const done = s.reviewDecision({ taskId: t.id, by: "u", decision: "approve" });
    expect(done.status).toBe("done");
    expect(done.deliveredBy).toBe("system");
  });

  test("un aggiornamento che NON entra in review non riscrive la firma", () => {
    const t = s.create({ projectId: PID, text: "x" });
    s.deliverToReviewBySystem({ taskId: t.id, reason: "budget finito", cause: "retries_exhausted" });
    const same = s.update({ taskId: t.id, actor: "human", by: "u", patch: { priority: 1 } });
    expect(same.deliveredBy).toBe("system");
    // …e nemmeno un re-ingresso in review da già-in-review (non è una transizione).
    const still = s.update({ taskId: t.id, actor: "human", by: "u", patch: { status: "review" } });
    expect(still.deliveredBy).toBe("system");
  });
});

describe("recordChecks (evidenza dei checks pre-review)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  const read = (id: string) => s.get(id, { projectId: PID })!.task;

  test("un task nasce SENZA esito: null non è un verde", () => {
    const t = s.create({ projectId: PID, text: "x" });
    expect(t.checksState).toBeNull();
    expect(t.checksAt).toBeNull();
    expect(t.checksCommit).toBeNull();
    expect(t.checks).toBeNull();
  });

  test("pass: stato, commit ed evidenza comando-per-comando rileggibili", () => {
    const t = s.create({ projectId: PID, text: "x" });
    const runs = [{ name: "typecheck", cmd: "bun run typecheck", ok: true, code: 0, ms: 1200, timedOut: false, tail: "" }];
    s.recordChecks({ taskId: t.id, state: "pass", commit: "abc1234", runs });
    const got = read(t.id);
    expect(got.checksState).toBe("pass");
    expect(got.checksCommit).toBe("abc1234");
    expect(got.checksAt).toBeTruthy();
    expect(got.checks).toEqual(runs);
  });

  test("running: nessun 'quando è finito', perché non è finito", () => {
    const t = s.create({ projectId: PID, text: "x" });
    s.recordChecks({ taskId: t.id, state: "running", commit: "abc1234", runs: null });
    const got = read(t.id);
    expect(got.checksState).toBe("running");
    expect(got.checksAt).toBeNull();
    expect(got.checks).toBeNull();
  });

  test("fail: la coda dell'output sopravvive al giro in DB (è l'unica prova che resta)", () => {
    const t = s.create({ projectId: PID, text: "x" });
    s.recordChecks({
      taskId: t.id, state: "fail", commit: "deadbee",
      runs: [
        { name: "typecheck", cmd: "bun run typecheck", ok: true, code: 0, ms: 900, timedOut: false, tail: "" },
        { name: "test", cmd: "bun test", ok: false, code: 1, ms: 4200, timedOut: false, tail: "1 fail\nexpected true" },
      ],
    });
    const got = read(t.id);
    expect(got.checksState).toBe("fail");
    expect(got.checks).toHaveLength(2);
    expect(got.checks![1].ok).toBe(false);
    expect(got.checks![1].tail).toContain("expected true");
  });

  test("un giro nuovo SOSTITUISCE il precedente: niente verde scaduto appiccicato", () => {
    const t = s.create({ projectId: PID, text: "x" });
    s.recordChecks({ taskId: t.id, state: "fail", commit: "old", runs: [{ name: "t", cmd: "false", ok: false, code: 1, ms: 5, timedOut: false, tail: "boom" }] });
    s.recordChecks({ taskId: t.id, state: "pass", commit: "new", runs: [{ name: "t", cmd: "true", ok: true, code: 0, ms: 5, timedOut: false, tail: "" }] });
    const got = read(t.id);
    expect(got.checksState).toBe("pass");
    expect(got.checksCommit).toBe("new");
    expect(got.checks).toHaveLength(1);
    expect(got.checks![0].ok).toBe(true);
  });

  test("reset a null: 'mai girati' è uno stato raggiungibile", () => {
    const t = s.create({ projectId: PID, text: "x" });
    s.recordChecks({ taskId: t.id, state: "fail", commit: "abc", runs: [{ name: "t", cmd: "false", ok: false, code: 1, ms: 5, timedOut: false, tail: "boom" }] });
    s.recordChecks({ taskId: t.id, state: null, commit: null, runs: null });
    const got = read(t.id);
    expect(got.checksState).toBeNull();
    expect(got.checksCommit).toBeNull();
    expect(got.checks).toBeNull();
  });

  test("un JSON storto in colonna vale 'nessuna evidenza', non un'eccezione a ogni lettura", () => {
    const t = s.create({ projectId: PID, text: "x" });
    db.prepare("UPDATE tasks SET checks_state = 'fail', checks_json = ? WHERE id = ?").run("{non json", t.id);
    const got = read(t.id);
    expect(got.checksState).toBe("fail");
    expect(got.checks).toBeNull();
  });

  test("task inesistente → not_found, non una UPDATE a vuoto", () => {
    expect(() => s.recordChecks({ taskId: "nope", state: "pass", commit: null, runs: null })).toThrow(TaskServiceError);
  });

  /**
   * «running» è una promessa che qualcuno scriverà l'esito, e chi la mantiene è
   * una corsa che vive nel processo. Un riavvio la porta via: senza questa
   * pulizia la card fila per sempre, che è il guasto misurato il 13/08.
   */
  test("al boot le spie 'running' si spengono, e SOLO quelle", () => {
    const gira = s.create({ projectId: PID, text: "sta girando" });
    const verde = s.create({ projectId: PID, text: "verde" });
    const rosso = s.create({ projectId: PID, text: "rosso" });
    s.recordChecks({ taskId: gira.id, state: "running", commit: "abc", runs: null });
    s.recordChecks({ taskId: verde.id, state: "pass", commit: "abc", runs: [{ name: "t", cmd: "true", ok: true, code: 0, ms: 5, timedOut: false, tail: "" }] });
    s.recordChecks({ taskId: rosso.id, state: "fail", commit: "abc", runs: [{ name: "t", cmd: "false", ok: false, code: 1, ms: 5, timedOut: false, tail: "boom" }] });

    expect(s.clearStaleChecksRuns()).toBe(1);
    expect(read(gira.id).checksState).toBeNull();
    expect(read(verde.id).checksState).toBe("pass");
    expect(read(rosso.id).checksState).toBe("fail");
    // L'ultima misura vera resta: si spegne la spia, non l'evidenza.
    expect(read(rosso.id).checks).toHaveLength(1);
    expect(s.clearStaleChecksRuns()).toBe(0);
  });
});

describe("review-evidence promotion — preview_image garantita dal commento di consegna", () => {
  let db: Database;
  const mk = (exists: (p: string) => boolean) => {
    let n = 500;
    return createTaskService(db, {
      now: () => new Date().toISOString(),
      uuid: () => `pv-${++n}`,
      fileExists: exists,
    });
  };
  beforeEach(() => { db = freshDb(); });

  const preview = (id: string) =>
    (db.prepare("SELECT preview_image FROM tasks WHERE id = ?").get(id) as any)?.preview_image ?? null;

  test("comment-first: il media del commento diventa preview al passaggio in review", () => {
    const s = mk(() => true);
    const t = s.create({ projectId: PID, text: "fix ui" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto", media: ["/Users/x/.topics/media/evidenza.png"] });
    expect(preview(t.id)).toBeNull(); // non ancora in review: nessuna promozione
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBe("/Users/x/.topics/media/evidenza.png");
  });

  test("evidenza arrivata DOPO la review (commento di consegna solo testo) riempie la preview", () => {
    const s = mk(() => true);
    const t = s.create({ projectId: PID, text: "fix ui" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto, evidenza a seguire" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBeNull();
    s.addComment({ taskId: t.id, author: "claude", content: "evidenza", media: ["/Users/x/.topics/media/clip.webm"] });
    expect(preview(t.id)).toBe("/Users/x/.topics/media/clip.webm");
  });

  test("una preview esplicita non viene mai sovrascritta", () => {
    const s = mk(() => true);
    const t = s.create({ projectId: PID, text: "fix ui" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { previewImage: "/Users/x/.topics/media/scelta.png" } });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto", media: ["/Users/x/.topics/media/altra.png"] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBe("/Users/x/.topics/media/scelta.png");
  });

  test("file inesistente o non-previewable (pdf/log) non viene promosso", () => {
    const s = mk((p) => p.endsWith(".png") === false ? true : false); // il png "non esiste", il resto sì
    const t = s.create({ projectId: PID, text: "fix ui" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto", media: ["/Users/x/.topics/media/morto.png", "/Users/x/.topics/media/report.pdf"] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBeNull(); // png inesistente, pdf non previewable
  });

  test("più commenti: vince il media del commento più recente", () => {
    const clock = { t: Date.parse("2026-07-20T10:00:00.000Z") };
    let n = 900;
    const s = createTaskService(db, {
      now: () => new Date(clock.t).toISOString(),
      uuid: () => `pv2-${++n}`,
      fileExists: () => true,
    });
    const t = s.create({ projectId: PID, text: "fix ui" });
    s.addComment({ taskId: t.id, author: "claude", content: "progress", media: ["/m/vecchia.png"] });
    clock.t += 60_000;
    s.addComment({ taskId: t.id, author: "claude", content: "consegna", media: ["/m/finale.png"] });
    clock.t += 60_000;
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBe("/m/finale.png");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Il ramo DIAGRAMMA, e i due controlli che lo accompagnano.
//
// `PREVIEW_RULE` ha un terzo ramo per le consegne senza superficie renderizzata
// (un piano, un'architettura, una migrazione): si consegna un diagramma `.svg`.
// Senza `svg` fra le estensioni promuovibili quel ramo nasceva morto — l'agente
// allegava il diagramma e la card restava cieca. Qui i file sono VERI su disco:
// il gate di forma legge l'header, e con path finti non misurerebbe niente.
// ─────────────────────────────────────────────────────────────────────────────
describe("anteprima: ramo diagramma, gate di forma, duplicati", () => {
  let db: Database;
  let dir: string;
  let n = 0;
  const mk = () => createTaskService(db, { now: () => new Date().toISOString(), uuid: () => `dg-${++n}` });
  beforeEach(() => { db = freshDb(); dir = mkdtempSync(join(tmpdir(), "task-preview-")); });

  const preview = (id: string) =>
    (db.prepare("SELECT preview_image FROM tasks WHERE id = ?").get(id) as any)?.preview_image ?? null;
  const notes = (id: string) =>
    (db.prepare("SELECT content FROM task_comments WHERE task_id = ? AND kind = 'review-note'").all(id) as any[])
      .map((r) => r.content as string);

  const write = (name: string, bytes: Buffer | string): string => {
    const p = join(dir, name);
    writeFileSync(p, bytes);
    return p;
  };
  /** Header PNG (firma + IHDR): è tutto ciò che il gate di forma legge. */
  const png = (name: string, w: number, h: number): string => {
    const b = Buffer.alloc(33);
    b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
    b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6;
    return write(name, b);
  };
  const svg = (name: string, w: number, h: number): string =>
    write(name, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="40" height="20"/></svg>`);

  // ── Il ritiro è uno STATO, non un messaggio ───────────────────────────────
  // La bonifica delle anteprime false ha scritto «⚠️ Anteprima RITIRATA…» nel
  // thread di 23 card. Un messaggio non invecchia: dove l'anteprima è tornata
  // continua a dire il contrario. Il fatto vive in colonna, e quello che si
  // prova qui è che si SPEGNE da solo — perché è quella la differenza fra uno
  // stato e una nota.
  const retired = (id: string) =>
    db.prepare("SELECT preview_retired_at AS at, preview_retired_reason AS why FROM tasks WHERE id = ?").get(id) as
      { at: string | null; why: string | null };

  test("ritirare l'anteprima toglie l'immagine E scrive il motivo sulla card", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "consegna con evidenza falsa" });
    const shot = png("schermata.png", 1440, 760);
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { previewImage: shot } });
    expect(preview(t.id)).toBe(shot);

    const dopo = s.retirePreview({ taskId: t.id, reason: "identica a quella di altre 12 card" });
    expect(preview(t.id)).toBeNull();
    expect(dopo.previewImage).toBeNull();
    expect(dopo.previewRetiredAt).not.toBeNull();
    expect(dopo.previewRetiredReason).toBe("identica a quella di altre 12 card");
    expect(retired(t.id).why).toBe("identica a quella di altre 12 card");
  });

  test("un'anteprima NUOVA spegne il ritiro: lo stato non sopravvive al fatto", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "riconsegna" });
    s.retirePreview({ taskId: t.id, reason: "placeholder, non evidenza" });
    expect(retired(t.id).at).not.toBeNull();

    const buona = png("vera.png", 1440, 760);
    const dopo = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { previewImage: buona } });
    expect(dopo.previewImage).toBe(buona);
    expect(dopo.previewRetiredAt).toBeNull();
    expect(dopo.previewRetiredReason).toBeNull();
  });

  test("anche l'adozione automatica dal commento di consegna spegne il ritiro", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "consegna via allegato" });
    s.retirePreview({ taskId: t.id, reason: "503, non evidenza" });
    const buona = png("consegnata.png", 1440, 760);
    s.addComment({ taskId: t.id, author: "claude", content: "consegna", media: [buona] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBe(buona);
    expect(retired(t.id).at).toBeNull();
  });

  // Azzerare a mano NON è un ritiro: chi toglie l'immagine senza dare un motivo
  // non sta dicendo «era falsa», e la card non deve inventarsi una spiegazione.
  // THE RETIREMENT MUST SURVIVE A RESTART.
  // Taking the image off the card does not take it out of the thread: it stays
  // attached to the comment the card took it from, which is exactly where the
  // startup sweep fishes. With no memory of what was rejected it put the
  // just-rejected shot back and switched the retirement off while doing it.
  test("il ritiro sopravvive alla spazzata d'avvio: la foto respinta non torna", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "consegna con foto falsa allegata" });
    const fake = png("falsa.png", 1440, 760);
    // The shot is attached to the thread, as always: it is the verifier note.
    s.addComment({ taskId: t.id, author: "verifier", content: "Anteprima viva pronta", media: [fake] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBe(fake);

    s.retirePreview({ taskId: t.id, reason: "mostrava lo stato vuoto dell'app" });
    expect(preview(t.id)).toBeNull();

    // Server restart: the startup sweep goes over the cards in review again.
    s.sweepReviewPreviews();
    // No false shot, and the reason is still written. The card may carry a
    // delivery SHEET (the fallback the server draws), which is not evidence and
    // does not switch the retirement off.
    const dopo = preview(t.id);
    expect(dopo === null || isDeliverySheetPath(dopo)).toBe(true);
    expect(dopo).not.toBe(fake);
    expect(retired(t.id).at).not.toBeNull();

    // Nor does it sneak back via the carousel: same lie, one slide over.
    expect(s.get(t.id)!.task.previewImages ?? []).not.toContain(fake);
  });

  // REAL evidence arriving later must still win: the rejection memory is a
  // list of paths, not a ban on the card.
  test("dopo un ritiro una foto NUOVA viene promossa lo stesso", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "riconsegna dopo il ritiro" });
    const fake = png("vuota.png", 1440, 760);
    s.addComment({ taskId: t.id, author: "verifier", content: "anteprima", media: [fake] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    s.retirePreview({ taskId: t.id, reason: "pagina bianca" });

    const buona = png("davvero.png", 1440, 760);
    s.addComment({ taskId: t.id, author: "claude", content: "ecco il lavoro", media: [buona] });
    s.sweepReviewPreviews();
    expect(preview(t.id)).toBe(buona);
    expect(retired(t.id).at).toBeNull();
  });

  test("azzerare l'anteprima con una stringa vuota non accende nessuno stato", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "ripensamento" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { previewImage: png("a.png", 1440, 760) } });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { previewImage: "" } });
    expect(preview(t.id)).toBeNull();
    expect(retired(t.id).at).toBeNull();
  });

  test("un .svg allegato al commento di consegna DIVENTA l'anteprima della card", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "piano di migrazione" });
    const diagram = svg("piano.svg", 900, 420);
    s.addComment({ taskId: t.id, author: "claude", content: "consegna: lo schema del piano", media: [diagram] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBe(diagram);
    expect(s.get(t.id)!.task.previewImage).toBe(diagram); // e arriva fino al client
  });

  test("una consegna SENZA nessun allegato non scrive nulla nel thread", () => {
    // Prima scriveva «Consegna SENZA anteprima» nel thread dell'umano:
    // 39 copie nel DB (misurato il 18/08), 26 card distinte. Il promemoria
    // viveva nel posto sbagliato: istruzioni operative per l'agente recapitate
    // a chi decide, che non puo' eseguirle. La regola vive ora nell'envelope
    // (PREVIEW_RULE in buildKickoff e buildResume).
    const s = mk();
    const t = s.create({ projectId: PID, text: "consegna a parole" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto, cinque cancelli verdi" });
    const after = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });

    expect(after.status).toBe("review");          // non e' un blocco
    expect(preview(t.id)).toBeNull();
    expect(notes(t.id)).toHaveLength(0);          // nessuna review-note nel thread
  });

  test("con un allegato promosso non si scrive nessuna nota di card cieca", () => {
    // La negazione: il segnale deve dipendere dall'ASSENZA, non essere un
    // rumore che accompagna ogni consegna.
    const s = mk();
    const t = s.create({ projectId: PID, text: "consegna con schema" });
    s.addComment({ taskId: t.id, author: "claude", content: "consegna", media: [svg("schema.svg", 900, 420)] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(notes(t.id).some((n) => n.includes("SENZA anteprima"))).toBe(false);
  });

  test("un'immagine più alta che larga (h/w > 0.7) non viene promossa e lascia una nota", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "piano fotografato" });
    s.addComment({ taskId: t.id, author: "claude", content: "consegna", media: [png("intero-piano.png", 1200, 4000)] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });

    expect(preview(t.id)).toBeNull();
    expect(notes(t.id)[0]).toContain("1200×4000");
    expect(notes(t.id)[0]).toContain("DIAGRAMMA");
  });

  test("il rifiuto NON blocca la consegna: il task resta in review, l'allegato nel thread", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "piano fotografato" });
    const tall = png("alta.png", 1000, 3000);
    s.addComment({ taskId: t.id, author: "claude", content: "consegna", media: [tall] });
    const after = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });

    expect(after.status).toBe("review");
    const thread = s.get(t.id)!.comments;
    expect(thread.some((c) => (c.media ?? []).includes(tall))).toBe(true);
  });

  test("la nota non si ripete: la promozione ripassa dallo stesso file a ogni commento", () => {
    // Clock che avanza: la promozione legge i commenti ORDER BY created_at DESC,
    // e con timestamp identici l'ordine è arbitrario (visto: il test passava da
    // solo e cadeva nella suite intera).
    const clock = { t: Date.parse("2026-08-10T09:00:00.000Z") };
    let k = 0;
    const s = createTaskService(db, { now: () => new Date(clock.t).toISOString(), uuid: () => `dgn-${++k}` });
    const t = s.create({ projectId: PID, text: "piano" });
    const tall = png("alta.png", 800, 2400);
    s.addComment({ taskId: t.id, author: "claude", content: "consegna", media: [tall] });
    clock.t += 60_000;
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    clock.t += 60_000;
    s.addComment({ taskId: t.id, author: "claude", content: "e ancora", media: [tall] });
    expect(notes(t.id).length).toBe(1);
    // Un file DIVERSO è un rifiuto diverso, e quello si dice.
    clock.t += 60_000;
    s.addComment({ taskId: t.id, author: "claude", content: "un'altra", media: [png("alta2.png", 800, 2400)] });
    expect(notes(t.id).length).toBe(2);
  });

  test("appena sotto la soglia passa: il gate taglia il documento fotografato, non il quasi-quadrato", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "un pannello" });
    const ok = png("pannello.png", 1000, 690); // 0.69
    s.addComment({ taskId: t.id, author: "claude", content: "consegna", media: [ok] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBe(ok);
    expect(notes(t.id)).toEqual([]);
  });

  test("forma non misurabile (un video, un formato che non si legge) ⇒ si promuove lo stesso", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "comportamento" });
    const clip = write("clip.webm", Buffer.alloc(2048)); // nessun header leggibile
    s.addComment({ taskId: t.id, author: "claude", content: "consegna", media: [clip] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBe(clip);
  });

  test("anteprima byte-identica a quella di un altro task: SEGNALE, non blocco", () => {
    const s = mk();
    const a = s.create({ projectId: PID, text: "il primo task" });
    const b = s.create({ projectId: PID, text: "il secondo task" });
    const one = svg("uno.svg", 600, 300);
    const clone = write("due.svg", readFileSync(one)); // stesso contenuto, altro path

    s.update({ taskId: a.id, actor: "agent", by: "claude", patch: { previewImage: one } });
    const after = s.update({ taskId: b.id, actor: "agent", by: "claude", patch: { previewImage: clone } });

    expect(after.previewImage).toBe(clone);      // messa comunque: è un segnale
    expect(notes(b.id)[0]).toContain("IDENTICA");
    expect(notes(b.id)[0]).toContain(a.id);
    expect(notes(a.id)).toEqual([]);             // il primo non c'entra niente
  });

  test("anteprime diverse: nessun rumore nel thread", () => {
    const s = mk();
    const a = s.create({ projectId: PID, text: "primo" });
    const b = s.create({ projectId: PID, text: "secondo" });
    s.update({ taskId: a.id, actor: "agent", by: "claude", patch: { previewImage: svg("a.svg", 600, 300) } });
    s.update({ taskId: b.id, actor: "agent", by: "claude", patch: { previewImage: svg("b.svg", 640, 300) } });
    expect(notes(b.id)).toEqual([]);
  });
});

/**
 * I NUMERI SI POSSONO RIEMPIRE SENZA BUTTARE VIA IL VERDETTO.
 *
 * `recordDelivery` azzera `landing_state` / `landing_witnessed` apposta: una
 * consegna nuova invalida il verdetto della precedente. Ma la passata di
 * backfill non registra consegne nuove — misura quelle che ci sono gia' — e
 * usarla li' avrebbe fatto due danni a ogni giro di trenta minuti: verdetto
 * testimoniato buttato, e `stat` non misurabile scritto NULL sopra numeri buoni.
 *
 * Misurato il 18/08: 294 card in review/done con un ramo, un commit e nessun
 * numero. Il buco sta nei percorsi che portano una card in review SENZA passare
 * da fine turno (`askParkedChildren` chiamata da un cambio di stato dei figli
 * scrive con una UPDATE grezza), e la passata periodica li ripara per tutti
 * invece di aggiungere una quarta copia di `captureDelivery`.
 */
describe("setDeliveryStat: i numeri senza toccare il resto", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  function conConsegna(): string {
    const t = s.create({ projectId: PID, text: "consegna" });
    s.recordDelivery({ taskId: t.id, branch: "topics/x", commit: "abc123", stat: null });
    return t.id;
  }

  test("riempie il buco quando i numeri mancano", () => {
    const id = conConsegna();
    expect(s.setDeliveryStat({ taskId: id, filesChanged: 3, insertions: 190, deletions: 12 })).toBe(true);
    const t = s.get(id)!.task;
    expect(t.deliveryFilesChanged).toBe(3);
    expect(t.deliveryInsertions).toBe(190);
    expect(t.deliveryDeletions).toBe(12);
  });

  test("NON tocca ramo e commit: la consegna non e' cambiata", () => {
    const id = conConsegna();
    s.setDeliveryStat({ taskId: id, filesChanged: 3, insertions: 190, deletions: 12 });
    const t = s.get(id)!.task;
    expect(t.deliveryBranch).toBe("topics/x");
    expect(t.deliveryCommit).toBe("abc123");
  });

  test("NON azzera il verdetto di atterraggio, che e' il punto", () => {
    // E' la differenza con `recordDelivery`, ed e' la ragione per cui questa
    // funzione esiste: chiamata ogni 30 minuti su 294 card, `recordDelivery`
    // avrebbe fatto ripartire da zero ogni verdetto gia' testimoniato.
    const id = conConsegna();
    db.prepare("UPDATE tasks SET landing_state = 'landed', landing_witnessed = 1 WHERE id = ?").run(id);
    s.setDeliveryStat({ taskId: id, filesChanged: 1, insertions: 1, deletions: 0 });
    const row = db.prepare("SELECT landing_state, landing_witnessed FROM tasks WHERE id = ?").get(id) as
      { landing_state: string | null; landing_witnessed: number };
    expect(row.landing_state).toBe("landed");
    expect(row.landing_witnessed).toBe(1);
  });

  test("su una card GIA' misurata non scrive: seconda cintura contro la sovrascrittura", () => {
    const t = s.create({ projectId: PID, text: "consegna" });
    s.recordDelivery({ taskId: t.id, branch: "topics/x", commit: "abc123",
      stat: { filesChanged: 9, insertions: 759, deletions: 21 } });
    expect(s.setDeliveryStat({ taskId: t.id, filesChanged: 1, insertions: 1, deletions: 1 })).toBe(false);
    expect(s.get(t.id)!.task.deliveryFilesChanged).toBe(9);
  });

  test("il controllo: recordDelivery AZZERA il verdetto, ed e' giusto cosi'", () => {
    // Senza questo caso il test qui sopra si leggerebbe come «i verdetti non si
    // azzerano mai», che e' falso e pericoloso: una consegna NUOVA deve buttare
    // il verdetto della precedente.
    const id = conConsegna();
    db.prepare("UPDATE tasks SET landing_state = 'landed', landing_witnessed = 1 WHERE id = ?").run(id);
    s.recordDelivery({ taskId: id, branch: "topics/x", commit: "def456", stat: null });
    const row = db.prepare("SELECT landing_state, landing_witnessed FROM tasks WHERE id = ?").get(id) as
      { landing_state: string | null; landing_witnessed: number };
    expect(row.landing_state).toBeNull();
    expect(row.landing_witnessed).toBe(0);
  });
});

/**
 * LA SCHEDA DI CONSEGNA: l'anteprima che c'e' SEMPRE.
 *
 * Il 20/08 la colonna review aveva 9 card su 16 col riquadro vuoto: nessun
 * allegato nel thread da promuovere, e l'anteprima viva rifiutata dal cancello
 * sul contenuto (il worktree serve un 503 senza bundle). Il vuoto era una
 * scelta — «un silenzio onesto» — ma a 9 su 16 non segnalava piu' niente.
 * Qui si prova l'ultimo ramo: se non c'e' evidenza, il server DISEGNA i fatti
 * che ha in colonna, e si fa da parte appena ne arriva una vera.
 */
describe("scheda di consegna (anteprima disegnata dal server)", () => {
  let db: Database;
  let dir: string;
  let n = 0;
  const scritte: string[] = [];
  const mk = () => createTaskService(db, {
    now: () => new Date().toISOString(),
    uuid: () => `sh-${++n}`,
    writeDeliverySheet: (taskId, svgText) => {
      const p = join(dir, "task-sheets", `${taskId}.svg`);
      mkdirSync(join(dir, "task-sheets"), { recursive: true });
      writeFileSync(p, svgText);
      scritte.push(p);
      return p;
    },
  });
  beforeEach(() => { db = freshDb(); dir = mkdtempSync(join(tmpdir(), "task-sheet-")); scritte.length = 0; });

  const preview = (id: string) =>
    (db.prepare("SELECT preview_image FROM tasks WHERE id = ?").get(id) as any)?.preview_image ?? null;

  test("numbers that arrive LATER redraw the sheet that shows them", () => {
    // THE SHEET SHOWS THE DIFFSTAT, and the diffstat lands late: the sheet is
    // drawn when the card enters review, while `delivery_files_changed` is
    // filled by the backfill pass half an hour later, for the paths that reach
    // review without going through the end of a turn. Nobody redrew it, so the
    // card kept the first drawing.
    //
    // Measured on 2026-09-01 on card `dec39cd3`: the sheet read zero files and
    // zero lines both ways while the column held 4 files and +157 lines — not
    // an empty box, a box stating the opposite of the truth, and the only thing
    // that card showed.
    const s = mk();
    const t = s.create({ projectId: PID, text: "delivery with late numbers" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    s.recordDelivery({ taskId: t.id, branch: "topics/late-numbers", commit: "abc123", stat: null });

    expect(readFileSync(preview(t.id)!, "utf-8")).toContain("SCHEDA DI CONSEGNA");

    // MEASURED ON THE WRITE, not on the pixels: the sheet no longer prints a
    // diffstat, so late numbers change no glyph. What this test is about is
    // that their arrival REDRAWS, and the spy is the only observable that
    // survives the content change.
    const prima = scritte.length;
    expect(s.setDeliveryStat({ taskId: t.id, filesChanged: 4, insertions: 157, deletions: 12 })).toBe(true);
    expect(scritte.length).toBeGreaterThan(prima);
    // And the digits stay out of the figure.
    expect(readFileSync(preview(t.id)!, "utf-8")).not.toContain("+157");
  });

  test("the sweep REDRAWS a sheet whose numbers changed underneath it", () => {
    // The real case of `dec39cd3`: the sheet is born without numbers, the
    // backfill pass writes them half an hour later, and the card kept the first
    // drawing. The boot sweep only looked at BLIND cards, so it never reached
    // this one. Now it redraws it — and does not count it as rescued, because
    // it was not.
    const s = mk();
    const t = consegna(s, "sheet to refresh");
    expect(preview(t.id)).toContain("task-sheets");
    const prima = scritte.length;

    // The numbers arrive later, through a path that does not redraw (a raw
    // UPDATE, like the backfill pass before the cure).
    db.prepare(
      "UPDATE tasks SET delivery_branch = 'topics/late', delivery_files_changed = 4, " +
      "delivery_insertions = 157, delivery_deletions = 12 WHERE id = ?",
    ).run(t.id);

    expect(s.sweepReviewPreviews()).toBe(0); // it was not blind: not a rescue
    // Redrawn all the same: the sweep rewrites it, and the write is the proof.
    expect(scritte.length).toBeGreaterThan(prima);
    expect(readFileSync(preview(t.id)!, "utf-8")).not.toContain("+157");
  });

  test("a card that is NO LONGER in review does not get its sheet redrawn", () => {
    // `ensureDeliverySheet` returns immediately outside review: the numbers of a
    // card that is already closed must not redraw a box on it.
    const s = mk();
    const t = s.create({ projectId: PID, text: "delivery already closed" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    s.recordDelivery({ taskId: t.id, branch: "topics/closed", commit: "abc123", stat: null });
    s.update({ taskId: t.id, actor: "human", by: "u", patch: { status: "done" } });
    const before = scritte.length;

    s.setDeliveryStat({ taskId: t.id, filesChanged: 4, insertions: 157, deletions: 12 });
    expect(scritte.length).toBe(before);
  });

  const consegna = (s: TaskService, testo: string) => {
    const t = s.create({ projectId: PID, text: testo });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto, cinque cancelli verdi" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    return t;
  };

  test("una consegna a parole non lascia piu' la card cieca: c'e' la scheda", () => {
    const s = mk();
    const t = consegna(s, "consegna a parole");
    expect(preview(t.id)).toBe(join(dir, "task-sheets", `${t.id}.svg`));
    const disegno = readFileSync(preview(t.id)!, "utf-8");
    expect(disegno).toContain("SCHEDA DI CONSEGNA");
    expect(disegno).toContain("consegna a parole");
  });

  test("la scheda porta CIO' CHE E' STATO FATTO, non il diffstat", () => {
    const s = mk();
    const t = consegna(s, "lavoro con ramo");
    db.prepare(
      "UPDATE tasks SET delivery_branch = 'topics/fading-falcon', delivery_files_changed = 12, delivery_insertions = 340, delivery_deletions = 7, preview_image = NULL WHERE id = ?",
    ).run(t.id);
    expect(s.sweepReviewPreviews()).toBe(1);
    const disegno = readFileSync(preview(t.id)!, "utf-8");
    // The fixture leaves the agent's own word in the thread: that is the body.
    expect(disegno).toContain("fatto");
    expect(disegno).not.toContain("topics/fading-falcon");
    expect(disegno).not.toContain("+340");
  });

  /** A DUPLICATE AUTO SHOT IS NOT EVIDENCE, AND A NOTE IS NOT A GATE: measured
   *  2026-09-01, task 1f225c0f carried byte for byte the empty-app frame of
   *  1c8fd103, noted and used anyway. A note still fits an image a PERSON
   *  attached; an identical automatic capture only means the app was idle. */
  test("uno scatto automatico identico a quello di un'altra card non viene adottato", () => {
    const s = mk();
    mkdirSync(join(dir, "task-previews"), { recursive: true });
    const first = consegna(s, "prima card");
    const shot = join(dir, "task-previews", "dup-a.png");
    writeFileSync(shot, "PNGPNGPNG");
    s.addComment({ taskId: first.id, author: "claude", content: "ecco", media: [shot] });
    expect(preview(first.id)).toBe(shot);

    const second = consegna(s, "seconda card");
    const twin = join(dir, "task-previews", "dup-b.png");
    writeFileSync(twin, "PNGPNGPNG");
    s.addComment({ taskId: second.id, author: "claude", content: "ecco", media: [twin] });

    expect(preview(second.id)).not.toBe(twin);
    expect(preview(second.id)).toContain("task-sheets");
  });

  /** AND THE ONES ALREADY ADOPTED: refusing new duplicates leaves the old ones
   *  on screen for ever (2026-09-02, two cards, one frame). The sweep retires
   *  the copy - the LATER file - and hands that card back to its sheet. */
  test("la passata ritira uno scatto duplicato gia' adottato", () => {
    const s = mk();
    mkdirSync(join(dir, "task-previews"), { recursive: true });
    const first = consegna(s, "prima card");
    const shot = join(dir, "task-previews", "old-a.png");
    writeFileSync(shot, "IDENTICI");
    s.addComment({ taskId: first.id, author: "claude", content: "ecco", media: [shot] });

    // The second one gets there BEFORE the gate exists: written straight in.
    const second = consegna(s, "seconda card");
    const twin = join(dir, "task-previews", "old-b.png");
    writeFileSync(twin, "IDENTICI");
    // The copy is written LATER: its mtime is what tells the two apart.
    utimesSync(shot, new Date(1_000_000), new Date(1_000_000));
    db.prepare("UPDATE tasks SET preview_image = ? WHERE id = ?").run(twin, second.id);
    expect(preview(second.id)).toBe(twin);

    s.sweepReviewPreviews();

    expect(preview(second.id)).not.toBe(twin);
    expect(preview(second.id)).toContain("task-sheets");
    expect(preview(first.id)).toBe(shot);
  });

  test("un'evidenza VERA nel thread vince sulla scheda e la sostituisce", () => {
    const s = mk();
    const t = consegna(s, "consegna con schermata");
    expect(preview(t.id)).toContain("task-sheets");
    const shot = join(dir, "schermata.png");
    const b = Buffer.alloc(33);
    b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
    b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(1440, 16); b.writeUInt32BE(760, 20); b[24] = 8; b[25] = 6;
    writeFileSync(shot, b);
    s.addComment({ taskId: t.id, author: "claude", content: "ecco la schermata", media: [shot] });
    expect(preview(t.id)).toBe(shot);
  });

  test("l'anteprima di una persona non viene mai coperta dalla scheda", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "consegna con evidenza propria" });
    const mia = join(dir, "mia.svg");
    writeFileSync(mia, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 420"></svg>`);
    s.addComment({ taskId: t.id, author: "claude", content: "consegna" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { previewImage: mia } });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBe(mia);
  });

  test("il ritiro non toglie la scheda: toglierla riporterebbe la card cieca", () => {
    const s = mk();
    const t = consegna(s, "consegna senza superficie");
    const scheda = preview(t.id);
    const dopo = s.retirePreview({ taskId: t.id, reason: "l'anteprima viva ha risposto 503" });
    expect(dopo.previewImage).toBe(scheda);
  });

  test("senza il servizio di scrittura iniettato la card resta com'era (nessun effetto)", () => {
    const s = svc(db);
    const t = consegna(s, "host senza media dir");
    expect(preview(t.id)).toBeNull();
  });

  test("la spazzata copre le card gia' ferme in review, e non ripassa due volte", () => {
    const s = mk();
    const t = consegna(s, "card ferma in review");
    db.prepare("UPDATE tasks SET preview_image = NULL WHERE id = ?").run(t.id);
    expect(s.sweepReviewPreviews()).toBe(1);
    expect(preview(t.id)).toContain("task-sheets");
    expect(s.sweepReviewPreviews()).toBe(0); // gia' coperta: non e' piu' in lista
  });
});
