/**
 * La traduzione di una violazione di CHECK, provata sugli errori VERI di
 * SQLite: il messaggio (`CHECK constraint failed: <espressione>`) è un dettaglio
 * del motore, e una stringa scritta a mano nel test proverebbe solo che il test
 * e il codice sono d'accordo fra loro. Qui l'errore lo produce il DB.
  * @covers KANBAN-51
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { checkConstraintBody } from "./task-patch";
import { TASKS_DDL, TASKS_FK_STUBS_DDL } from "../db/test-schema";

/** Esegue la scrittura e restituisce l'errore che il DB ha alzato. */
function violazione(run: (db: Database) => void): unknown {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  try {
    run(db);
  } catch (e) {
    return e;
  }
  throw new Error("la scrittura è passata: il vincolo non ha morso");
}

const inserisci = (cols: string, vals: unknown[]) => (db: Database) =>
  db.prepare(
    `INSERT INTO tasks (id, project_id, text, created_at, updated_at, ${cols}) ` +
    `VALUES ('t1', 'pX', 'x', '2026-08-13', '2026-08-13', ${vals.map(() => "?").join(", ")})`,
  ).run(...vals as any[]);

describe("checkConstraintBody: la regola a parole al posto dell'SQL", () => {
  test("priority fuori range: 400 col range, e zero SQL nel messaggio", () => {
    const body = checkConstraintBody(violazione(inserisci("priority", [9])));
    expect(body).not.toBeNull();
    expect(body!.code).toBe("invalid_input");
    expect(body!.fields).toEqual(["priority"]);
    expect(body!.error).toContain("da 0 a 4");
    expect(body!.error).not.toContain("BETWEEN");
  });

  test("status fuori dominio: il messaggio elenca i valori ammessi", () => {
    const body = checkConstraintBody(violazione(inserisci("status", ["quasi_fatto"])));
    expect(body!.fields).toEqual(["status"]);
    expect(body!.error).toContain("backlog");
    expect(body!.error).toContain("done");
    expect(body!.error).not.toContain("CHECK");
  });

  test("un CHECK che questo file non conosce: niente SQL comunque", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE q (n INTEGER CHECK(n > 100))");
    const err = (() => { try { db.run("INSERT INTO q (n) VALUES (1)"); } catch (e) { return e; } })();
    const body = checkConstraintBody(err);
    expect(body!.code).toBe("invalid_input");
    expect(body!.fields).toEqual([]);
    expect(body!.error).not.toContain("CHECK");
  });

  test("un errore che NON è un CHECK resta un 500: `null`", () => {
    expect(checkConstraintBody(new Error("boom"))).toBeNull();
    // Una FK violata non è un dominio chiuso: qui la traduzione non entra.
    const fk = violazione(inserisci("blocked_by_task_id", ["non-esiste"]));
    expect(checkConstraintBody(fk)).toBeNull();
  });
});
