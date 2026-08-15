/**
 * Quanto pesa APRIRE la board.
 *
 * `GET /api/all-boards/tasks` è la prima richiesta che parte quando si apre la
 * board, ed è l'unica lista di questa app che cresce con il lavoro fatto: 467
 * radici sulla macchina viva. Nessun cancello ne guardava i byte, e in una sola
 * tornata è passata da 1.435.735 a 2.089.815 byte (+45%) mentre la latenza
 * MIGLIORAVA (145 ms → 34 ms): il mappatore a lotti aveva reso la risposta
 * veloce, e nello stesso giro la lista si era caricata di tre cose che la card
 * non legge — `recentComments` interi su 455 schede su 467 (731 KB, per 11 che
 * li disegnano), `descriptionPreview` (110 KB) ACCANTO alla `description`
 * intera (470 KB), tenuta «per compatibilità» con un client che nel frattempo
 * non la leggeva più. Un numero che nessuno misura è un numero che va nella
 * direzione sbagliata senza far rumore.
 *
 * Qui si misura la ROTTA VERA, sui byte che escono dal `Response`, con la
 * proporzione del database vivo: descrizioni lunghe su ogni riga e un thread su
 * ogni scheda. Tre cose, e la prima è quella che conta:
 *
 *  1. INVARIANTI: nella lista non c'è né il testo intero di una descrizione né
 *     quello di un commento, e i commenti stanno SOLO sulle schede che li
 *     disegnano. Sono proprietà strutturali: non si ricalibrano, e vanno rosse
 *     il giorno in cui uno dei tre torna.
 *  2. BUDGET: i byte per task sulla fixture. Serve a vedere il grasso NUOVO,
 *     quello che nessun invariante conosce ancora.
 *  3. LO SPECCHIO: lo stesso payload rimesso nella forma di prima deve sfondare
 *     il budget. Una condizione che non si è mai vista fallire è un ornamento.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createTasksRouter } from "../../server/routes/tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../../server/db/test-schema";
import type { RouteHandler } from "../../server/types";

/** Le righe della board vera: 300 radici, un terzo in review. */
const TASKS = 300;
/** La coda misurata sul DB vivo (massimo 5.140 byte di descrizione). */
const DESCRIPTION_CHARS = 2500;
/** Un commento come quelli veri: la mediana sta molto sotto, il massimo sopra. */
const COMMENT_CHARS = 2800;
const COMMENTS_PER_TASK = 4;

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASKS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, auto_dispatch INTEGER NOT NULL DEFAULT 0,
    dispatch_retry_cap INTEGER, review_checks TEXT,
    max_agents INTEGER DEFAULT 5, max_agents_auto INTEGER
  )`);
  return db;
}

/** Il testo di una descrizione: una sola lettera, così ritrovarla nel payload
 *  è una domanda senza ambiguità. */
const DESCRIPTION = "d".repeat(DESCRIPTION_CHARS);
const COMMENT = "c".repeat(COMMENT_CHARS);

function seed(db: Database): void {
  const checks = JSON.stringify([
    { name: "typecheck", cmd: "bun run typecheck", ok: true, code: 0, ms: 4210, timedOut: false, tail: "x".repeat(600) },
  ]);
  const ins = db.prepare(
    `INSERT INTO tasks (id, project_id, text, description, status, priority, kanban_order,
                        created_at, updated_at, assigned_topic_id, checks_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insC = db.prepare(
    "INSERT INTO task_comments (id, task_id, author, content, created_at, kind) VALUES (?, ?, ?, ?, ?, 'comment')",
  );
  db.run("INSERT INTO topics (id) VALUES ('topic-1')");
  for (let i = 0; i < TASKS; i++) {
    const status = i % 3 === 0 ? "review" : i % 3 === 1 ? "todo" : "done";
    ins.run(
      `t-${i}`, `board-${i % 5}`, `task numero ${i}`, DESCRIPTION, status, i % 5, i,
      `2026-08-${String((i % 27) + 1).padStart(2, "0")}T10:00:00.000Z`, "2026-08-15T10:00:00.000Z",
      status === "review" ? "topic-1" : null, checks,
    );
    // Ogni scheda ha un thread: è la fixture che rende visibile il difetto,
    // perché i commenti viaggiavano su TUTTE le colonne.
    for (let k = 0; k < COMMENTS_PER_TASK; k++) {
      insC.run(`c-${i}-${k}`, `t-${i}`, k % 2 ? "claude" : "user", COMMENT, `2026-08-15T10:0${k}:00.000Z`);
    }
  }
}

function router(db: Database): RouteHandler {
  return createTasksRouter({
    db,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async () => null,
    matchRoute: () => null,
    broadcast: () => {},
    broadcastToAll: () => {},
    getTopicBySessionKey: () => null,
    requestIdentity: () => null,
  } as never);
}

interface WireTask {
  id: string;
  status: string;
  description: string | null;
  descriptionPreview: string | null;
  recentComments: Array<Record<string, unknown>>;
}

async function feed(db: Database): Promise<{ body: string; tasks: WireTask[] }> {
  const url = new URL("http://127.0.0.1:3333/api/all-boards/tasks");
  const resp = await router(db)(new Request(url), url, url.pathname, "GET");
  expect(resp?.status).toBe(200);
  const body = await resp!.text();
  return { body, tasks: (JSON.parse(body) as { tasks: WireTask[] }).tasks };
}

describe("il peso di GET /api/all-boards/tasks", () => {
  test("INVARIANTE: la lista non porta né la descrizione intera né il testo dei commenti", async () => {
    const db = freshDb();
    seed(db);
    const { body, tasks } = await feed(db);
    expect(tasks.length).toBe(TASKS);
    // La prova che la fixture ha davvero il grasso addosso: senza questa riga
    // le due negazioni sotto sarebbero verdi su un database vuoto.
    expect((db.query("SELECT COUNT(*) n FROM task_comments").get() as { n: number }).n)
      .toBe(TASKS * COMMENTS_PER_TASK);
    expect(body).not.toContain("d".repeat(300));
    expect(body).not.toContain("c".repeat(1300));
    expect(body).not.toContain("x".repeat(300)); // la coda dei check
    // E ciò che la card disegna c'è: l'anteprima, tagliata.
    expect(tasks[0]!.descriptionPreview!.length).toBe(240);
    expect(tasks[0]!.description).toBeNull();
  });

  test("INVARIANTE: i commenti stanno solo sulle schede che li disegnano, e con i tre campi che la card legge", async () => {
    const db = freshDb();
    seed(db);
    const { tasks } = await feed(db);
    const review = tasks.filter((t) => t.status === "review");
    const altre = tasks.filter((t) => t.status !== "review");
    expect(review.length).toBeGreaterThan(50);
    expect(altre.length).toBeGreaterThan(50);
    // La colonna che li disegna li ha…
    for (const t of review) expect(t.recentComments.length).toBe(3);
    // …e nessun'altra: erano 455 schede su 467 a portarli, per 11 che li leggono.
    for (const t of altre) expect(t.recentComments).toEqual([]);
    // Tre campi, non nove: `id`, `taskId`, `createdAt`, `mentions` e `media`
    // sulla card non li tocca nessuno.
    for (const c of review[0]!.recentComments) {
      expect(Object.keys(c).sort()).toEqual(["author", "content", "kind"]);
    }
  });

  test("BUDGET: i byte per task della fixture restano sotto il tetto", async () => {
    const db = freshDb();
    seed(db);
    const { body, tasks } = await feed(db);
    const perTask = body.length / tasks.length;
    // Misurato il 15/08/2026 su questa fixture: 2.159 byte per task. Da dove
    // vengono, perché il numero non è quello che sembra: 1.227 sono i NOMI
    // delle 63 chiavi con i loro `null` — il pavimento di questa forma, non
    // grasso — più 263 dell'anteprima (che è ciò che la card disegna) e la
    // frase di `queueReason` sulle card in coda. Sotto i 700 byte per task non
    // ci si arriva accorciando: ci si arriva togliendo chiavi, che è un altro
    // cambio con un altro client da avvisare.
    //
    // Il tetto sta fra la misura e i 2.826 byte che la stessa fixture pesava
    // con i commenti attaccati a OGNI colonna: ci si sfonda rimettendo la
    // `description` (+2.500 a riga), togliendo il gate della review, o
    // togliendo il taglio del testo.
    expect(perTask).toBeLessThan(2600);
    // E il pavimento del cancello: se un giorno la fixture smettesse di portare
    // il thread o le descrizioni, il budget andrebbe verde misurando niente.
    expect(perTask).toBeGreaterThan(1200);
  });

  test("LO SPECCHIO: lo stesso payload nella forma di prima sfonda il budget", async () => {
    const db = freshDb();
    seed(db);
    const { body, tasks } = await feed(db);
    // La forma di prima: la `description` intera su ogni riga (tenuta «per
    // compatibilità») e i commenti INTERI su ogni scheda, non solo in review.
    const thread = db.query(
      "SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 3",
    );
    const grasso = tasks.map((t) => ({
      ...t,
      description: DESCRIPTION,
      recentComments: thread.all(t.id),
    }));
    const primaBytes = JSON.stringify({ tasks: grasso }).length;
    expect(primaBytes / tasks.length).toBeGreaterThan(2000);
    // +45% era la misura del guasto; qui il rapporto è più netto perché la
    // fixture dà un thread a ogni scheda, cioè il caso peggiore verso cui il
    // database vivo sta andando.
    expect(primaBytes).toBeGreaterThan(body.length * 3);
  });
});
