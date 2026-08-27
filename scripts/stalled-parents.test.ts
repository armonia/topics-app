/**
 * La sonda deve saper contare CINQUE e saper contare ZERO, e le due misure sono
 * la stessa board a due istanti diversi: quella del 12/08/2026 com'era (due padri
 * parcheggiati, tre figli sotto) e quella dopo che i cinque stati sono stati
 * mossi a mano. Una sonda che non sa tornare a zero è un allarme rotto; una che
 * non sa salire a cinque non è una sonda.
  * @covers DOCTOR-02
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStalls, render } from "./stalled-parents";

const SCHEMA = `CREATE TABLE tasks (
    id TEXT PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL,
    parent_task_id TEXT, archived INTEGER NOT NULL DEFAULT 0,
    dispatch_state TEXT, delivered_reason TEXT, dispatch_deferred_until TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;

/**
 * La sonda legge anche il THREAD, da quando il padre che chiede senza potersi
 * firmare (consegna vera in review, domanda posata fra i commenti) va escluso:
 * senza questa tabella la fixture morirebbe con «no such table», che è il modo
 * più silenzioso di non provare niente.
 */
const SCHEMA_COMMENTS = `CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL,
    content TEXT NOT NULL, created_at TEXT NOT NULL
  )`;

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA);
  db.run(SCHEMA_COMMENTS);
  return db;
}

/** Un commento di sistema nel thread, con l'ora che decide se la domanda vale. */
function comment(db: Database, taskId: string, content: string, createdAt: string): void {
  db.prepare(
    "INSERT INTO task_comments (id, task_id, author, content, created_at) VALUES (?, ?, 'system', ?, ?)",
  ).run(`c${seq++}`, taskId, content, createdAt);
}

let seq = 0;
function card(
  db: Database,
  id: string,
  status: string,
  opts: {
    parent?: string;
    dispatchState?: string | null;
    archived?: boolean;
    deliveredReason?: string | null;
    deferredUntil?: string | null;
  } = {},
): string {
  const ts = new Date(Date.UTC(2026, 7, 12, 3, seq++)).toISOString();
  db.prepare(
    "INSERT INTO tasks (id, text, status, parent_task_id, archived, dispatch_state, delivered_reason, dispatch_deferred_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id, `card ${id}`, status, opts.parent ?? null, opts.archived ? 1 : 0,
    opts.dispatchState ?? null, opts.deliveredReason ?? null, opts.deferredUntil ?? null, ts, ts,
  );
  return id;
}

/** La board com'era: due padri fermi in backlog, tre figli parcheggiati sotto. */
function boardDel12(db: Database): void {
  card(db, "fae36197", "backlog", { dispatchState: "blocked" });
  card(db, "450c9e32", "backlog", { parent: "fae36197" });
  card(db, "40fa2cbf", "backlog", { dispatchState: "blocked" });
  card(db, "209d30fb", "backlog", { parent: "40fa2cbf" });
  card(db, "f904cacd", "backlog", { parent: "40fa2cbf" });
}

describe("la sonda degli stalli muti", () => {
  test("i cinque stati del 12/08: due padri, cinque card ferme", () => {
    const db = freshDb();
    boardDel12(db);
    const r = findStalls(db);
    expect(r.parents).toBe(2);
    expect(r.cards).toBe(5);
    expect(r.stalls.flatMap((s) => s.parked.map((c) => c.id)).sort())
      .toEqual(["209d30fb", "450c9e32", "f904cacd"]);
  });

  test("mossi i figli in todo, la sonda torna a zero", () => {
    const db = freshDb();
    boardDel12(db);
    db.run("UPDATE tasks SET status = 'todo' WHERE parent_task_id IS NOT NULL");
    db.run("UPDATE tasks SET status = 'todo', dispatch_state = 'queued' WHERE parent_task_id IS NULL");
    const r = findStalls(db);
    expect(r.parents).toBe(0);
    expect(render(r)).toBe("Nessuno stallo muto: 0 padri, 0 card ferme.");
  });

  test("un padre AL LAVORO non è uno stallo: c'è un turno che se ne accorgerà", () => {
    const db = freshDb();
    card(db, "vivo", "in_progress", { dispatchState: "working" });
    card(db, "step", "backlog", { parent: "vivo" });
    expect(findStalls(db).parents).toBe(0);
  });

  test("un padre che STA GIÀ CHIEDENDO non è muto: è in review con la domanda", () => {
    const db = freshDb();
    // `delivered_reason` è il marchio che scrive `askParkedChildren`, ed è
    // l'UNICO segno che la domanda sulla card è proprio questa: `needs_input`
    // da solo lo scrive anche `deliverToReviewBySystem` per qualunque causa.
    card(db, "chiede", "review", { dispatchState: "needs_input", deliveredReason: "parked_children" });
    card(db, "sotto", "backlog", { parent: "chiede" });
    expect(findStalls(db).parents).toBe(0);
  });

  test("il padre che chiede dal THREAD non è muto, anche senza il marchio sulla riga", () => {
    // Su una consegna vera dell'agente la domanda si posa fra i commenti e la
    // card non si muove: scriverle `delivered_by = 'system'` sopra sarebbe una
    // bugia al reviewer. Il marchio è la domanda stessa.
    const db = freshDb();
    card(db, "consegnato", "review", { dispatchState: "delivered" });
    card(db, "rimandato", "backlog", { parent: "consegnato" });
    expect(findStalls(db).parents).toBe(1);
    comment(db, "consegnato", "```question\nRestano passi parcheggiati\n- Rimetti in coda i sottotask\n- Archivia i sottotask\n```", "2027-01-01T00:00:00.000Z");
    expect(findStalls(db).parents).toBe(0);
  });

  test("una domanda più VECCHIA del parcheggio non copre il parcheggio nuovo", () => {
    const db = freshDb();
    card(db, "consegnato", "review", { dispatchState: "delivered" });
    card(db, "rimandato", "backlog", { parent: "consegnato" });
    comment(db, "consegnato", "```question\n- Rimetti in coda i sottotask\n```", "2020-01-01T00:00:00.000Z");
    expect(findStalls(db).parents).toBe(1);
  });

  test("un padre MAI dispacciato conta lo stesso: dispatch_state NULL non lo nasconde", () => {
    // La trappola SQL che questa riga chiude: `dispatch_state NOT IN (...)` vale
    // NULL su una card mai dispacciata, e avrebbe scartato proprio le più ferme.
    const db = freshDb();
    card(db, "mai", "backlog", { dispatchState: null });
    card(db, "figlio", "backlog", { parent: "mai" });
    expect(findStalls(db).parents).toBe(1);
  });

  test("figli chiusi o archiviati non tengono fermo nessuno", () => {
    const db = freshDb();
    card(db, "padre", "backlog");
    card(db, "fatto", "done", { parent: "padre" });
    card(db, "buttato", "backlog", { parent: "padre", archived: true });
    expect(findStalls(db).parents).toBe(0);
  });

  test("basta UN figlio col PROPRIO agente e non è stallo: quello si muove davvero", () => {
    const db = freshDb();
    card(db, "padre", "backlog");
    card(db, "vivo", "in_progress", { parent: "padre", dispatchState: "working" });
    card(db, "parcheggiato", "backlog", { parent: "padre" });
    expect(findStalls(db).parents).toBe(0);
  });
});

/**
 * IL CASO CHE LA SONDA NON VEDEVA — otto card in una notte, il 12/08/2026.
 *
 * Un figlio in `todo` sembrava «in volo» e bastava a far tacere la sonda. Non lo
 * è: uno step non lo dispaccia MAI nessuno da solo (`rootsOnly` nel tick,
 * «Steps are never dispatch-eligible» in `onEnterTodo`), lo lavora solo l'agente
 * del padre DENTRO il proprio turno. Se il padre non ha un turno vivo, un figlio
 * in `todo` è fermo esattamente quanto uno in `backlog` — e `deriveQueueReason`
 * lo dice già, con `tone: 'stalled'`, mentre la sonda diceva il contrario.
 *
 * Il padre in `review` chiudeva il vicolo: sembra «aspetta l'umano», ma l'umano
 * non ha nessuna mossa — approvare porta a `done`, e `done` con un sottotask
 * aperto è rifiutato (`open_subtasks`). La checklist è congelata e la card tace.
 */
describe("il padre in review con la checklist congelata", () => {
  test("figli in TODO sotto un padre in review: è uno stallo, e la sonda lo conta", () => {
    const db = freshDb();
    card(db, "review1", "review", { dispatchState: "needs_input" });
    card(db, "step1", "todo", { parent: "review1" });
    card(db, "step2", "todo", { parent: "review1" });
    const r = findStalls(db);
    expect(r.parents).toBe(1);
    expect(r.cards).toBe(3);
    expect(r.stalls[0]!.parked.map((c) => c.id).sort()).toEqual(["step1", "step2"]);
  });

  test("il figlio in todo NON è in volo nemmeno sotto un padre in backlog", () => {
    const db = freshDb();
    card(db, "fermo", "backlog");
    card(db, "step", "todo", { parent: "fermo" });
    expect(findStalls(db).parents).toBe(1);
  });

  test("il padre AL LAVORO resta escluso: quel turno la checklist la lavora davvero", () => {
    const db = freshDb();
    card(db, "vivo", "in_progress", { dispatchState: "working" });
    card(db, "step", "todo", { parent: "vivo" });
    expect(findStalls(db).parents).toBe(0);
  });

  test("finestra di rinvio ancora APERTA: non è ferma, sta per rientrare in coda", () => {
    const db = freshDb();
    // `deferForWait` e il ramo dei sottotask aperti rimandano il padre di 10
    // minuti: dentro quella finestra il turno è previsto, e `deriveQueueReason`
    // la chiama `deferred`, `tone: 'waiting'`. Dirla ferma sarebbe un allarme.
    card(db, "rinviato", "todo", { dispatchState: "waiting", deferredUntil: "2026-08-12T19:05:00.000Z" });
    card(db, "step", "todo", { parent: "rinviato" });
    expect(findStalls(db, "2026-08-12T19:00:00.000Z").parents).toBe(0);
  });

  test("finestra di rinvio SCADUTA: nessuno è tornato, ed è ferma", () => {
    const db = freshDb();
    card(db, "scaduto", "todo", { dispatchState: "waiting", deferredUntil: "2026-08-12T17:54:00.000Z" });
    card(db, "step", "todo", { parent: "scaduto" });
    expect(findStalls(db, "2026-08-12T19:00:00.000Z").parents).toBe(1);
  });

  test("la riga del padre dice lo stato in cui è fermo, non solo l'id", () => {
    const db = freshDb();
    card(db, "review1", "review", { dispatchState: "needs_input" });
    card(db, "step1", "todo", { parent: "review1" });
    const testo = render(findStalls(db));
    expect(testo).toContain("review");
    expect(testo).toContain("review1");
    expect(testo).toContain("step1");
  });
});

/**
 * LA BARRA, sulla porta vera: non la funzione esportata, il comando.
 * `bun run probe:stalls --gate` deve uscire NON-ZERO su questa board.
 */
describe("probe:stalls --gate", () => {
  function seedFile(seed: (db: Database) => void): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "stalls-"));
    const path = join(dir, "topics.db");
    const db = new Database(path);
    db.run(SCHEMA);
    db.run(SCHEMA_COMMENTS);
    seed(db);
    db.close();
    return { dir, path };
  }

  function runProbe(path: string, ...args: string[]) {
    return Bun.spawnSync({
      cmd: ["bun", join(import.meta.dir, "stalled-parents.ts"), "--db", path, ...args],
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("padre in review + figli in todo: esce 1 e li nomina", () => {
    const { dir, path } = seedFile((db) => {
      card(db, "abcdef0123", "review", { dispatchState: "needs_input" });
      card(db, "9876543210", "todo", { parent: "abcdef0123" });
    });
    try {
      const r = runProbe(path, "--gate");
      const out = r.stdout.toString();
      expect(r.exitCode).not.toBe(0);
      expect(out).toContain("abcdef01");
      expect(out).toContain("98765432");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  /**
   * IL DB CHE NON SI APRE NON DEVE SEMBRARE UNA BOARD SANA — né uno stallo.
   *
   * `readonly` su un file WAL senza `-shm` vivo (cioè proprio la copia su cui si
   * indaga) muore con `SQLITE_CANTOPEN` prima di stampare qualsiasi cosa, e lo
   * stack di bun non nomina nemmeno il file. Peggio: usciva 1, lo STESSO codice
   * con cui `--gate` dice «ci sono stalli». Chi legge solo l'esito leggeva un
   * allarme dove c'era un percorso sbagliato.
   */
  test("--db che non si apre: dice quale file e come si fa, e non finge un allarme", () => {
    const dir = mkdtempSync(join(tmpdir(), "stalls-"));
    const path = join(dir, "non-esiste.db");
    try {
      const r = runProbe(path, "--gate");
      const err = r.stderr.toString();
      expect(err).toContain(path);
      // La mossa, non il codice d'errore: la copia va fatta con `.backup`.
      expect(err).toContain(".backup");
      // E un codice suo: 1 è già preso da «ci sono stalli».
      expect(r.exitCode).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("board sana: esce 0", () => {
    const { dir, path } = seedFile((db) => {
      card(db, "vivo", "in_progress", { dispatchState: "working" });
      card(db, "step", "todo", { parent: "vivo" });
    });
    try {
      const r = runProbe(path, "--gate");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain("Nessuno stallo muto");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
