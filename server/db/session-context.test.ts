/**
 * Lo stato del contesto per sessione. Le proprietà che contano:
 *  • una riga sola per sessione, sempre l'ULTIMA misura (è stato, non storia);
 *  • una misura impossibile non entra;
 *  • se la scrittura non può riuscire, il turno non ne risente — il ring è
 *    un'informazione, non una transazione.
 * @covers USAGE-06
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { recordSessionContext, getSessionContext } from "./session-context";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.run(readFileSync(join(import.meta.dir, "migrations", "060-session-context.sql"), "utf-8"));
});

describe("session-context", () => {
  test("scrive e rilegge l'ultima misura", () => {
    const row = recordSessionContext(db, {
      sessionKey: "sk1", usedTokens: 148_231, windowTokens: 200_000, model: "claude-opus-4-6",
    });
    expect(row?.usedTokens).toBe(148_231);
    const read = getSessionContext(db, "sk1");
    expect(read).toMatchObject({ sessionKey: "sk1", usedTokens: 148_231, windowTokens: 200_000, estimated: false, model: "claude-opus-4-6" });
    expect(read?.measuredAt).toBeTruthy();
  });

  test("una sessione = una riga: la misura nuova sovrascrive la vecchia", () => {
    // Durante un turno lungo `onContextSize` scatta a ogni chiamata: se ogni
    // misura inserisse una riga, una sola conversazione ne accumulerebbe
    // centinaia e la lettura dovrebbe ordinare per data per sapere DOVE sta.
    recordSessionContext(db, { sessionKey: "sk1", usedTokens: 10_000, windowTokens: 200_000 });
    recordSessionContext(db, { sessionKey: "sk1", usedTokens: 42_000, windowTokens: 200_000 });
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM session_context WHERE session_key = 'sk1'`).get() as { n: number };
    expect(rows.n).toBe(1);
    expect(getSessionContext(db, "sk1")?.usedTokens).toBe(42_000);
  });

  test("misure impossibili non entrano", () => {
    expect(recordSessionContext(db, { sessionKey: "sk1", usedTokens: 0, windowTokens: 200_000 })).toBeNull();
    expect(recordSessionContext(db, { sessionKey: "sk1", usedTokens: -3, windowTokens: 200_000 })).toBeNull();
    expect(recordSessionContext(db, { sessionKey: "sk1", usedTokens: Number.NaN, windowTokens: 200_000 })).toBeNull();
    expect(getSessionContext(db, "sk1")).toBeNull();
  });

  test("sessione sconosciuta → null, non un errore", () => {
    expect(getSessionContext(db, "mai-vista")).toBeNull();
  });

  test("`estimated` sopravvive al giro completo", () => {
    recordSessionContext(db, { sessionKey: "sk2", usedTokens: 5_000, windowTokens: 200_000, estimated: true, model: "modello-ignoto" });
    expect(getSessionContext(db, "sk2")?.estimated).toBe(true);
  });

  test("una FK che rifiuta la riga NON fa esplodere il chiamante", () => {
    // In produzione la FK punta a topics(session_key): una chat senza topic
    // (sessione esterna, chiave di prova) farebbe fallire l'INSERT. Quel
    // fallimento non deve mai risalire dentro il turno dell'agente.
    const fk = new Database(":memory:");
    fk.run(`CREATE TABLE topics (session_key TEXT PRIMARY KEY)`);
    fk.run(readFileSync(join(import.meta.dir, "migrations", "060-session-context.sql"), "utf-8"));
    fk.run(`PRAGMA foreign_keys = ON`);
    expect(() => recordSessionContext(fk, { sessionKey: "orfana", usedTokens: 1_000, windowTokens: 200_000 })).not.toThrow();
    expect(recordSessionContext(fk, { sessionKey: "orfana", usedTokens: 1_000, windowTokens: 200_000 })).toBeNull();
    fk.close();
  });
});
