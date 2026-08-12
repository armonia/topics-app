/**
 * La sonda deve saper contare CINQUE e saper contare ZERO, e le due misure sono
 * la stessa board a due istanti diversi: quella del 12/08/2026 com'era (due padri
 * parcheggiati, tre figli sotto) e quella dopo che i cinque stati sono stati
 * mossi a mano. Una sonda che non sa tornare a zero è un allarme rotto; una che
 * non sa salire a cinque non è una sonda.
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { findStalls, render } from "./stalled-parents";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL,
    parent_task_id TEXT, archived INTEGER NOT NULL DEFAULT 0,
    dispatch_state TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  return db;
}

let seq = 0;
function card(
  db: Database,
  id: string,
  status: string,
  opts: { parent?: string; dispatchState?: string | null; archived?: boolean } = {},
): string {
  const ts = new Date(Date.UTC(2026, 7, 12, 3, seq++)).toISOString();
  db.prepare(
    "INSERT INTO tasks (id, text, status, parent_task_id, archived, dispatch_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, `card ${id}`, status, opts.parent ?? null, opts.archived ? 1 : 0, opts.dispatchState ?? null, ts, ts);
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
    card(db, "chiede", "review", { dispatchState: "needs_input" });
    card(db, "sotto", "backlog", { parent: "chiede" });
    expect(findStalls(db).parents).toBe(0);
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

  test("basta UN figlio in volo e non è stallo: gli altri parcheggiati aspettano lui", () => {
    const db = freshDb();
    card(db, "padre", "backlog");
    card(db, "vivo", "todo", { parent: "padre" });
    card(db, "parcheggiato", "backlog", { parent: "padre" });
    expect(findStalls(db).parents).toBe(0);
  });
});
