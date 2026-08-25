/**
 * Il rollback a un checkpoint cancellava OGNI ramo della sessione, non solo
 * quello che veniva dopo il punto di ripristino. Qui si inchioda il confine:
 * cosa muore (il sottoalbero appeso al taglio) e cosa deve sopravvivere
 * (tutti i fratelli che divergono più in alto).
 * @covers CHAT-CONV-02
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { truncateSessionAfter } from "./message-tree";

const SK = "topic:uno";

let db: Database;

/** Lo schema minimo che il taglio tocca, FK comprese: senza, l'ordine di cancellazione non sarebbe verificato. */
function makeDb(): Database {
  const d = new Database(":memory:");
  d.run(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      sort_order INTEGER,
      parent_id TEXT REFERENCES messages(id),
      branch_index INTEGER DEFAULT 0
    );
    CREATE TABLE active_branches (
      parent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      active_branch_index INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (parent_id, session_key)
    );
    CREATE TABLE compaction_markers (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      after_message_id TEXT
    );
  `);
  d.run("PRAGMA foreign_keys = ON");
  return d;
}

let order = 0;
function msg(id: string, parent: string | null, opts: { session?: string; branch?: number } = {}) {
  db.prepare(
    `INSERT INTO messages (id, session_key, role, content, sort_order, parent_id, branch_index)
     VALUES (?, ?, 'user', ?, ?, ?, ?)`,
  ).run(id, opts.session ?? SK, id, order++, parent, opts.branch ?? 0);
}
const ids = (session = SK): string[] =>
  (db.prepare(`SELECT id FROM messages WHERE session_key = ? ORDER BY sort_order`).all(session) as { id: string }[])
    .map((r) => r.id);

beforeEach(() => {
  db = makeDb();
  order = 0;
});

describe("taglio del sottoalbero", () => {
  it("cancella ciò che viene dopo il punto di taglio", () => {
    msg("A", null); msg("B", "A"); msg("C", "B"); msg("D", "C");
    const r = truncateSessionAfter(db, SK, "B");
    expect(r.deletedMessages).toBe(2);
    expect(ids()).toEqual(["A", "B"]);
  });

  it("i FRATELLI che divergono SOPRA il taglio sopravvivono", () => {
    // È il difetto: `saveLocalMessages` rimpiazzava l'intera sessione col solo
    // ramo attivo, quindi B2 e il suo sottoalbero morivano pur essendo
    // alternative a un messaggio che il rollback TIENE.
    msg("A", null);
    msg("B1", "A", { branch: 0 }); msg("B2", "A", { branch: 1 }); msg("B2figlio", "B2");
    msg("C", "B1"); msg("D", "C");
    truncateSessionAfter(db, SK, "C");
    expect(ids()).toEqual(["A", "B1", "B2", "B2figlio", "C"]);
  });

  it("i fratelli SOTTO il taglio muoiono tutti, non solo il ramo attivo", () => {
    // C e C' sono due alternative per "cosa è successo dopo B": il rollback a
    // B dice che dopo B non è successo niente.
    msg("A", null); msg("B", "A");
    msg("C", "B", { branch: 0 }); msg("C1", "C");
    msg("Cbis", "B", { branch: 1 }); msg("Cbis1", "Cbis");
    const r = truncateSessionAfter(db, SK, "B");
    expect(r.deletedMessages).toBe(4);
    expect(ids()).toEqual(["A", "B"]);
  });

  it("tagliare a zero svuota la sessione, radici comprese", () => {
    msg("A", null); msg("B", "A"); msg("Abis", null);
    truncateSessionAfter(db, SK, null);
    expect(ids()).toEqual([]);
  });

  it("non tocca le ALTRE sessioni", () => {
    msg("A", null); msg("B", "A");
    msg("X", null, { session: "topic:due" });
    truncateSessionAfter(db, SK, null);
    expect(ids("topic:due")).toEqual(["X"]);
  });

  it("tagliare in fondo non cancella niente ed è idempotente", () => {
    msg("A", null); msg("B", "A");
    expect(truncateSessionAfter(db, SK, "B").deletedMessages).toBe(0);
    expect(truncateSessionAfter(db, SK, "B").deletedMessages).toBe(0);
    expect(ids()).toEqual(["A", "B"]);
  });

  it("un ciclo nell albero non manda in loop il taglio", () => {
    msg("A", null); msg("B", "A"); msg("C", "B");
    db.prepare(`UPDATE messages SET parent_id = 'C' WHERE id = 'B'`).run();
    expect(() => truncateSessionAfter(db, SK, "A")).not.toThrow();
  });

  it("conta i messaggi rimasti includendo i rami fuori dal percorso attivo", () => {
    msg("A", null); msg("B1", "A"); msg("B2", "A", { branch: 1 }); msg("C", "B1");
    expect(truncateSessionAfter(db, SK, "B1").remainingMessages).toBe(3);
  });
});

describe("pulizia di ciò che pendeva dai messaggi cancellati", () => {
  it("toglie le righe di active_branches orfane e quella del punto di taglio", () => {
    msg("A", null); msg("B", "A"); msg("C1", "B"); msg("C2", "B", { branch: 1 }); msg("D", "C1");
    db.prepare(`INSERT INTO active_branches VALUES ('B', ?, 0)`).run(SK);
    db.prepare(`INSERT INTO active_branches VALUES ('C1', ?, 0)`).run(SK);
    truncateSessionAfter(db, SK, "B");
    // Sotto B non c'è più alcun ramo fra cui scegliere: la riga sarebbe una bugia.
    expect(db.prepare(`SELECT COUNT(*) n FROM active_branches WHERE session_key = ?`).get(SK)).toEqual({ n: 0 });
  });

  it("lascia in piedi le scelte di ramo che stanno SOPRA il taglio", () => {
    msg("A", null); msg("B1", "A"); msg("B2", "A", { branch: 1 }); msg("C", "B1");
    db.prepare(`INSERT INTO active_branches VALUES ('A', ?, 0)`).run(SK);
    truncateSessionAfter(db, SK, "B1");
    expect(db.prepare(`SELECT COUNT(*) n FROM active_branches WHERE session_key = ?`).get(SK)).toEqual({ n: 1 });
  });

  it("toglie i divider di compaction ancorati a messaggi spariti", () => {
    msg("A", null); msg("B", "A"); msg("C", "B");
    db.prepare(`INSERT INTO compaction_markers VALUES ('m1', ?, 'C')`).run(SK);
    db.prepare(`INSERT INTO compaction_markers VALUES ('m2', ?, 'A')`).run(SK);
    const r = truncateSessionAfter(db, SK, "B");
    expect(r.deletedMarkers).toBe(1);
    expect((db.prepare(`SELECT id FROM compaction_markers`).all() as { id: string }[]).map((x) => x.id)).toEqual(["m2"]);
  });

  it("svuotando la sessione spariscono anche i divider senza ancora", () => {
    msg("A", null);
    db.prepare(`INSERT INTO compaction_markers VALUES ('m1', ?, NULL)`).run(SK);
    truncateSessionAfter(db, SK, null);
    expect(db.prepare(`SELECT COUNT(*) n FROM compaction_markers WHERE session_key = ?`).get(SK)).toEqual({ n: 0 });
  });
});
