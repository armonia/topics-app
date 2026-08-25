/**
 * `078-topic-model-1m-window.sql` — i pin di modello passano alla finestra da 1M.
 *
 * Una migration di DATI si prova per quello che NON tocca, non per quello che
 * tocca: appendere `[1m]` è banale, sbagliare il perimetro no. Le tre righe che
 * contano sono haiku (il beta non lo copre: `[1m]` là è un 400 a turno partito),
 * lo storico (un task chiuso registra cosa è girato davvero) e la
 * ri-esecuzione — la migration gira su DB già migrati a mano durante l'indagine,
 * e un secondo giro non deve produrre `claude-opus-5[1m][1m]`.
  * @covers SCHEMA-07
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";

const MIGRATION_SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, "server/db/migrations/078-topic-model-1m-window.sql"),
  "utf-8",
);

/**
 * Le colonne toccate, più quelle che devono restare ferme.
 *
 * Sottoinsieme deliberato: qui si misura una migration, quindi lo schema deve
 * essere quello del giorno in cui la 078 gira, non quello di oggi. Per questo
 * non arriva da `TASKS_DDL` (server/db/test-schema.ts), che è la catena
 * completa e comprende colonne nate DOPO.
 */
function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE topics (session_key TEXT PRIMARY KEY, model TEXT)");
  db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, model TEXT)");
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, model TEXT)");
  db.run("CREATE TABLE session_context (session_key TEXT PRIMARY KEY, model TEXT, window_tokens INTEGER)");
  return db;
}

const modelOf = (db: Database, table: string, id: string) =>
  (db.prepare(`SELECT model FROM ${table} WHERE ${table === "topics" ? "session_key" : "id"} = ?`)
    .get(id) as { model: string | null } | null)?.model ?? null;

describe("078 — pin di modello sulla finestra da 1M", () => {
  test("opus e sonnet passano al gemello [1m]; haiku, fable e non-Claude no", () => {
    const db = makeDb();
    const ins = db.prepare("INSERT INTO topics (session_key, model) VALUES (?, ?)");
    ins.run("t-opus", "claude-opus-4-8");
    ins.run("t-opus5", "claude-opus-5");
    ins.run("t-sonnet", "claude-sonnet-5");
    // Haiku NON regge il beta: `claude-haiku-4-5[1m]` risponde 400 «The long
    // context beta is not yet available for this subscription».
    ins.run("t-haiku", "claude-haiku-4-5");
    // Fable il milione ce l'ha già nudo: appendere il suffisso non aggiunge
    // niente e inventa un id.
    ins.run("t-fable", "claude-fable-5");
    ins.run("t-gpt", "gpt-5.6-terra");
    ins.run("t-null", null);

    db.run(MIGRATION_SQL);

    expect(modelOf(db, "topics", "t-opus")).toBe("claude-opus-4-8[1m]");
    expect(modelOf(db, "topics", "t-opus5")).toBe("claude-opus-5[1m]");
    expect(modelOf(db, "topics", "t-sonnet")).toBe("claude-sonnet-5[1m]");
    expect(modelOf(db, "topics", "t-haiku")).toBe("claude-haiku-4-5");
    expect(modelOf(db, "topics", "t-fable")).toBe("claude-fable-5");
    expect(modelOf(db, "topics", "t-gpt")).toBe("gpt-5.6-terra");
    expect(modelOf(db, "topics", "t-null")).toBeNull();
  });

  test("un secondo giro non raddoppia il suffisso", () => {
    const db = makeDb();
    db.run("INSERT INTO topics (session_key, model) VALUES ('t', 'claude-opus-5')");
    db.run(MIGRATION_SQL);
    db.run(MIGRATION_SQL);
    expect(modelOf(db, "topics", "t")).toBe("claude-opus-5[1m]");
  });

  test("i task ANCORA APERTI si spostano, quelli chiusi restano storia", () => {
    const db = makeDb();
    const ins = db.prepare("INSERT INTO tasks (id, status, model) VALUES (?, ?, ?)");
    ins.run("aperto", "backlog", "claude-opus-4-8");
    ins.run("in-review", "review", "claude-opus-4-8");
    ins.run("chiuso", "done", "claude-opus-4-8");

    db.run(MIGRATION_SQL);

    expect(modelOf(db, "tasks", "aperto")).toBe("claude-opus-4-8[1m]");
    expect(modelOf(db, "tasks", "in-review")).toBe("claude-opus-4-8[1m]");
    // Il modello di un task chiuso è il verbale di cosa è girato: riscriverlo
    // direbbe che quel lavoro è stato fatto su una finestra che non aveva.
    expect(modelOf(db, "tasks", "chiuso")).toBe("claude-opus-4-8");
  });

  test("lo storico delle misure non si tocca", () => {
    const db = makeDb();
    db.run("INSERT INTO messages (id, model) VALUES ('m1', 'claude-opus-4-8')");
    db.run("INSERT INTO session_context (session_key, model, window_tokens) VALUES ('t', 'claude-opus-4-8', 1000000)");

    db.run(MIGRATION_SQL);

    expect(modelOf(db, "messages", "m1")).toBe("claude-opus-4-8");
    const row = db.prepare("SELECT model, window_tokens FROM session_context WHERE session_key = 't'")
      .get() as { model: string; window_tokens: number };
    // `windowForMeasure()` ridimensiona la finestra sul modello del topic a ogni
    // lettura: la riga sbagliata si corregge da sé, riscriverla non serve.
    expect(row.model).toBe("claude-opus-4-8");
    expect(row.window_tokens).toBe(1_000_000);
  });
});
