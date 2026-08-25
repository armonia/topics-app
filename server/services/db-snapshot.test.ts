/**
 * Il ripristino è il confine ermetico della suite E2E: se mente, mente in
 * silenzio e il rosso spunta quaranta test più avanti. Questi test fissano le
 * proprietà che lo rendono affidabile — "esattamente com'era", comprese le
 * righe aggiunte a tabelle che nella fotografia erano vuote, e comprese le
 * foreign key, che devono tornare coerenti a COMMIT.
  * @covers E2E-GATE-03
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { listUserTables, restoreDb, snapshotDb } from "./db-snapshot";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)`);
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    content TEXT
  )`);
  db.run(`CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, server_seq INTEGER NOT NULL DEFAULT 0)`);
  return db;
}

function seedBaseline(db: Database): void {
  db.run("INSERT INTO topics (id, name) VALUES ('t1', 'Web Search Test')");
  db.run("INSERT INTO messages (id, topic_id, content) VALUES ('m1', 't1', 'ciao')");
  db.run("INSERT INTO ui_state (key, value, server_seq) VALUES ('panels', '{\"openPanels\":[]}', 3)");
}

const rowsOf = (db: Database, table: string) => db.query(`SELECT * FROM ${table} ORDER BY 1`).all();

describe("listUserTables", () => {
  it("elenca le tabelle utente e salta il catalogo interno di SQLite", () => {
    const db = freshDb();
    db.run("CREATE TABLE counters (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER)");
    db.run("INSERT INTO counters (n) VALUES (1)"); // popola sqlite_sequence
    expect(listUserTables(db)).toEqual(["counters", "messages", "topics", "ui_state"]);
  });
});

describe("snapshotDb + restoreDb", () => {
  it("riporta il DB esattamente alla fotografia", () => {
    const db = freshDb();
    seedBaseline(db);
    const snap = snapshotDb(db);

    db.run("INSERT INTO topics (id, name) VALUES ('t2', 'E2E-sporca')");
    db.run("INSERT INTO messages (id, topic_id, content) VALUES ('m2', 't2', 'rumore')");
    db.run("UPDATE topics SET archived = 1 WHERE id = 't1'");
    db.run("UPDATE ui_state SET value = '{\"openPanels\":[\"x\"]}' WHERE key = 'panels'");

    const res = restoreDb(db, snap);
    expect(res.rows).toBe(3);
    expect(res.missing).toEqual([]);
    expect(rowsOf(db, "topics")).toEqual([{ id: "t1", name: "Web Search Test", archived: 0 }]);
    expect(rowsOf(db, "messages")).toEqual([{ id: "m1", topic_id: "t1", content: "ciao" }]);
    expect(rowsOf(db, "ui_state")).toEqual([{ key: "panels", value: '{"openPanels":[]}', server_seq: 3 }]);
  });

  it("svuota anche le tabelle che nella fotografia erano VUOTE", () => {
    // È il caso che rompe un ripristino "ripasso solo ciò che ho": una spec che
    // crea la prima riga di una tabella la lascerebbe lì per tutta la run.
    const db = freshDb();
    db.run("INSERT INTO topics (id, name) VALUES ('t1', 'baseline')");
    const snap = snapshotDb(db);
    db.run("INSERT INTO ui_state (key, value, server_seq) VALUES ('pane-store-v2', '{}', 9)");

    restoreDb(db, snap);
    expect(rowsOf(db, "ui_state")).toEqual([]);
  });

  it("non si strozza sull'ordine delle foreign key", () => {
    // Svuotare `topics` prima di `messages` viola il vincolo a metà
    // transazione: deve reggere e uscire coerente, non esplodere.
    const db = freshDb();
    seedBaseline(db);
    const snap = snapshotDb(db);
    db.run("DELETE FROM topics"); // CASCADE porta via anche m1
    expect(rowsOf(db, "messages")).toEqual([]);

    expect(() => restoreDb(db, snap)).not.toThrow();
    expect(rowsOf(db, "messages")).toHaveLength(1);
    expect((db.query("PRAGMA foreign_key_check").all() as unknown[]).length).toBe(0);
  });

  it("una foreign key che a COMMIT resterebbe rotta fa fallire il ripristino, senza scrivere nulla", () => {
    const db = freshDb();
    seedBaseline(db);
    const snap = snapshotDb(db);
    // Fotografia manomessa: un messaggio che punta a una topic inesistente.
    snap.tables.find((t) => t.name === "messages")!.rows.push({ id: "m9", topic_id: "assente", content: "x" });

    expect(() => restoreDb(db, snap)).toThrow();
    // Il rollback deve aver lasciato il DB come stava — non a metà.
    expect(rowsOf(db, "topics")).toHaveLength(1);
    expect(rowsOf(db, "messages")).toHaveLength(1);
  });

  it("segnala le tabelle sparite invece di far esplodere il ripristino", () => {
    const db = freshDb();
    seedBaseline(db);
    const snap = snapshotDb(db);
    db.run("DROP TABLE messages");

    const res = restoreDb(db, snap);
    expect(res.missing).toEqual(["messages"]);
    expect(rowsOf(db, "topics")).toHaveLength(1);
  });

  it("afterInsert gira dentro la stessa transazione del ripristino", () => {
    const db = freshDb();
    seedBaseline(db);
    const snap = snapshotDb(db);
    db.run("UPDATE ui_state SET server_seq = 41");

    restoreDb(db, snap, {
      // È ciò che fa la route di reset: i server_seq ripristinati tornerebbero
      // INDIETRO (3 < 41) e un client che ne ha già visti di più alti
      // scarterebbe l'hydrate. Ritraslati sopra il massimo corrente.
      afterInsert: (d) => { d.run("UPDATE ui_state SET server_seq = server_seq + ?", [41]); },
    });
    expect((db.query("SELECT server_seq FROM ui_state").get() as { server_seq: number }).server_seq).toBe(44);
  });

  it("beforeDelete vede lo stato di ADESSO, prima che venga cancellato", () => {
    const db = freshDb();
    seedBaseline(db);
    const snap = snapshotDb(db);
    db.run("UPDATE ui_state SET server_seq = 41");

    let seen = -1;
    restoreDb(db, snap, {
      beforeDelete: (d) => {
        seen = (d.query("SELECT COALESCE(MAX(server_seq), 0) AS m FROM ui_state").get() as { m: number }).m;
      },
      afterInsert: (d) => { d.run("UPDATE ui_state SET server_seq = server_seq + ?", [seen]); },
    });
    expect(seen).toBe(41);
    expect((db.query("SELECT server_seq FROM ui_state").get() as { server_seq: number }).server_seq).toBe(44);
  });

  it("se afterInsert fallisce, l'intero ripristino torna indietro", () => {
    const db = freshDb();
    seedBaseline(db);
    const snap = snapshotDb(db);
    db.run("INSERT INTO topics (id, name) VALUES ('t2', 'sporca')");

    expect(() => restoreDb(db, snap, { afterInsert: () => { throw new Error("boom"); } })).toThrow("boom");
    expect(rowsOf(db, "topics")).toHaveLength(2); // niente è stato ripristinato
  });

  it("preserva i BLOB byte per byte", () => {
    const db = freshDb();
    db.run("CREATE TABLE blobs (id TEXT PRIMARY KEY, payload BLOB)");
    const bytes = new Uint8Array([0, 1, 255, 128, 0]);
    db.run("INSERT INTO blobs (id, payload) VALUES (?, ?)", ["b1", bytes]);
    const snap = snapshotDb(db);
    db.run("DELETE FROM blobs");

    restoreDb(db, snap);
    const back = (db.query("SELECT payload FROM blobs WHERE id = 'b1'").get() as { payload: Uint8Array }).payload;
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it("la fotografia è un valore inerte: serializzarla e rileggerla non cambia il ripristino", () => {
    // La baseline vive su disco come JSON fra un riavvio del server di test e
    // l'altro (routes/e2e.ts), quindi il round-trip deve essere fedele.
    const db = freshDb();
    seedBaseline(db);
    const snap = JSON.parse(JSON.stringify(snapshotDb(db)));
    db.run("DELETE FROM messages");

    restoreDb(db, snap);
    expect(rowsOf(db, "messages")).toEqual([{ id: "m1", topic_id: "t1", content: "ciao" }]);
  });
});
