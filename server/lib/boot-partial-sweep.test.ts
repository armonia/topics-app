/**
 * TURNO RESETTATO = MESSAGGIO VISIBILE NELLA CHAT.
 * TURNO VIVO NEL BROKER = KEPT, NON RESET.
 *
 * Il 2026-08-18: SIGKILL durante una chat viva. Al riavvio, il partial sweep
 * resettava i messaggi parziali (partial=1 → 0) ma non scriveva NIENTE nella
 * chat. L'utente vedeva solo il cartello "Interrotto" dentro il blocco del
 * tool — una riga dentro un oggetto JSON, non un messaggio del thread.
 *
 * Due invarianti da coprire (dalla BARRA della task e552e810):
 *
 * BARRA 1 — turno vivo + broker conferma → kept, non reset.
 *   Verde solo se il conteggio del sweep dice `kept`, non `reset`.
 *
 * BARRA 2 — turno resettato → messaggio visibile nella chat.
 *   `insertRestartNotification` inserisce un messaggio assistant con prefisso
 *   ⚠️ (RESTART_INTERRUPTED_MARKER). Questo attiva i comportamenti client
 *   esistenti senza nessun cambiamento al client:
 *     - banner ambra (turnErrorOf != null)
 *     - bottone "Riprova" (turnIsOnlyError = true, niente tool_calls)
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  insertRestartNotification,
  runBootPartialSweep,
  RESTART_INTERRUPTED_MARKER,
} from "./boot-partial-sweep";

// Schema minimo: solo le colonne che il sweep e insertRestartNotification toccano.
const DDL = `
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    partial INTEGER DEFAULT 0,
    streamed_at TEXT,
    timestamp TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    -- Lo schema di prova era piu povero di quello vero, e la differenza NON era
    -- innocua: senza queste due colonne il test non poteva accorgersi che il
    -- cartello nasceva orfano, cioe fuori dal filo della conversazione, dove
    -- loadActiveThread non passa e quindi nessuno lo legge. Dieci cartelli
    -- scritti in un giorno, zero visibili (20/08, DB di produzione).
    parent_id TEXT,
    branch_index INTEGER NOT NULL DEFAULT 0
  );
`;

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(DDL);
  return db;
}

function rows(db: Database, sk: string) {
  return db
    .query("SELECT * FROM messages WHERE session_key = ? ORDER BY sort_order")
    .all(sk) as Array<{
    id: string;
    session_key: string;
    role: string;
    content: string;
    partial: number;
    timestamp: string;
    sort_order: number;
  }>;
}

// ---------------------------------------------------------------------------
// BARRA 1: sweep kept/reset
// ---------------------------------------------------------------------------
describe("runBootPartialSweep", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("figlio vivo nel broker → kept, partial NON resettato, nessuna notifica", () => {
    db.run(
      "INSERT INTO messages (id, session_key, role, content, partial, streamed_at, timestamp, sort_order) VALUES ('m1', 'topic:vivo', 'assistant', 'parziale', 1, NULL, 't', 0)"
    );

    const liveSessions = new Set(["topic:vivo"]);
    const result = runBootPartialSweep(db, {
      listConfirmed: true,
      liveSessions,
      generateId: () => "notif",
      now: () => "t",
    });

    expect(result.kept).toBe(1);
    expect(result.cleared).toBe(0);

    // Il messaggio resta partial=1 (non resettato)
    const [msg] = rows(db, "topic:vivo");
    expect(msg.partial).toBe(1);

    // Nessun messaggio di notifica inserito
    expect(rows(db, "topic:vivo")).toHaveLength(1);
  });

  it("BARRA-2: nessun figlio vivo (il caso NATIVO) → reset + notifica in chat", () => {
    db.run(
      "INSERT INTO messages (id, session_key, role, content, partial, streamed_at, timestamp, sort_order) VALUES ('m1', 'topic:morto', 'assistant', 'parziale', 1, NULL, 't', 0)"
    );

    const result = runBootPartialSweep(db, {
      listConfirmed: true,
      liveSessions: new Set(),
      generateId: () => "notif-id",
      now: () => "2026-08-18T21:10:00Z",
    });

    expect(result.cleared).toBeGreaterThan(0);
    expect(result.kept).toBe(0);

    const all = rows(db, "topic:morto");
    expect(all).toHaveLength(2);

    // Il messaggio originale e' stato resettato
    const orig = all.find((r) => r.id === "m1");
    expect(orig!.partial).toBe(0);

    // La notifica e' stata inserita
    const notif = all.find((r) => r.id === "notif-id");
    expect(notif).toBeDefined();
    expect(notif!.content).toBe(RESTART_INTERRUPTED_MARKER);
    expect(notif!.partial).toBe(0);
    expect(notif!.role).toBe("assistant");
  });

  it("listConfirmed=false → tutto kept, nessun reset (fail-safe)", () => {
    db.run(
      "INSERT INTO messages (id, session_key, role, content, partial, streamed_at, timestamp, sort_order) VALUES ('m1', 'topic:forse-vivo', 'assistant', 'parziale', 1, NULL, 't', 0)"
    );

    const result = runBootPartialSweep(db, {
      listConfirmed: false,
      liveSessions: new Set(),
      generateId: () => "notif",
      now: () => "t",
    });

    expect(result.kept).toBe(1);
    expect(result.cleared).toBe(0);

    // Nessun reset, nessuna notifica
    const all = rows(db, "topic:forse-vivo");
    expect(all).toHaveLength(1);
    expect(all[0].partial).toBe(1);
  });

  it("piu' sessioni: viva→kept, morta→reset+notifica", () => {
    db.run("INSERT INTO messages (id, session_key, role, content, partial, streamed_at, timestamp, sort_order) VALUES ('v', 'sk:viva', 'assistant', 'p', 1, NULL, 't', 0)");
    db.run("INSERT INTO messages (id, session_key, role, content, partial, streamed_at, timestamp, sort_order) VALUES ('m', 'sk:morta', 'assistant', 'p', 1, NULL, 't', 0)");

    let counter = 0;
    const result = runBootPartialSweep(db, {
      listConfirmed: true,
      liveSessions: new Set(["sk:viva"]),
      generateId: () => `notif-${++counter}`,
      now: () => "t",
    });

    expect(result.kept).toBe(1);
    expect(result.cleared).toBeGreaterThan(0);

    // La sessione viva non e' stata toccata
    expect(rows(db, "sk:viva")).toHaveLength(1);
    expect(rows(db, "sk:viva")[0].partial).toBe(1);

    // La sessione morta ha la notifica
    expect(rows(db, "sk:morta")).toHaveLength(2);
  });

  it("nessun messaggio partial → nessun cambiamento", () => {
    db.run("INSERT INTO messages (id, session_key, role, content, partial, streamed_at, timestamp, sort_order) VALUES ('u', 'sk', 'user', 'ciao', 0, NULL, 't', 0)");

    const result = runBootPartialSweep(db, {
      listConfirmed: true,
      liveSessions: new Set(),
    });

    expect(result.kept).toBe(0);
    expect(result.cleared).toBe(0);
    expect(rows(db, "sk")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// BARRA 2: insertRestartNotification (logica di inserimento in isolamento)
// ---------------------------------------------------------------------------
describe("insertRestartNotification", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("inserisce un messaggio assistant visibile nella chat", () => {
    db.run(
      "INSERT INTO messages (id, session_key, role, content, partial, streamed_at, timestamp, sort_order) VALUES ('msg-1', 'topic:aabbcc', 'assistant', 'lavoro parziale', 0, NULL, '2026-08-18T21:00:00Z', 0)"
    );

    insertRestartNotification(db, "topic:aabbcc", {
      generateId: () => "notif-1",
      now: () => "2026-08-18T21:10:00Z",
    });

    const all = rows(db, "topic:aabbcc");
    expect(all).toHaveLength(2);

    const notif = all.find((r) => r.id === "notif-1");
    expect(notif).toBeDefined();
    expect(notif!.role).toBe("assistant");
    expect(notif!.content).toBe(RESTART_INTERRUPTED_MARKER);
    expect(notif!.partial).toBe(0);
    expect(notif!.timestamp).toBe("2026-08-18T21:10:00Z");
  });

  it("sort_order del messaggio di notifica e' il massimo + 1", () => {
    db.run("INSERT INTO messages (id, session_key, role, content, partial, streamed_at, timestamp, sort_order) VALUES ('a', 'sk', 'user', 'msg A', 0, NULL, 't', 0)");
    db.run("INSERT INTO messages (id, session_key, role, content, partial, streamed_at, timestamp, sort_order) VALUES ('b', 'sk', 'assistant', 'msg B', 0, NULL, 't', 1)");
    db.run("INSERT INTO messages (id, session_key, role, content, partial, streamed_at, timestamp, sort_order) VALUES ('c', 'sk', 'assistant', 'parziale', 1, NULL, 't', 2)");

    insertRestartNotification(db, "sk", { generateId: () => "n", now: () => "t" });

    const notif = rows(db, "sk").find((r) => r.id === "n");
    expect(notif!.sort_order).toBe(3);
  });

  it("su una sessione vuota sort_order e' 0", () => {
    insertRestartNotification(db, "sk-vuota", { generateId: () => "n", now: () => "t" });
    const [msg] = rows(db, "sk-vuota");
    expect(msg.sort_order).toBe(0);
  });

  it("non tocca le altre sessioni", () => {
    db.run("INSERT INTO messages (id, session_key, role, content, partial, streamed_at, timestamp, sort_order) VALUES ('x', 'altra-sk', 'user', 'x', 0, NULL, 't', 0)");
    insertRestartNotification(db, "target-sk", { generateId: () => "n", now: () => "t" });
    expect(rows(db, "altra-sk")).toHaveLength(1);
  });

  it("il contenuto inizia con ⚠️ (attiva banner ambra e bottone Riprova nel client)", () => {
    insertRestartNotification(db, "sk", { generateId: () => "n", now: () => "t" });
    const [msg] = rows(db, "sk");
    expect(msg.content.startsWith("⚠️")).toBe(true);
  });

  it("piu' sessioni resettate nello stesso avvio ricevono ciascuna il proprio messaggio", () => {
    insertRestartNotification(db, "sk-1", { generateId: () => "n1", now: () => "t" });
    insertRestartNotification(db, "sk-2", { generateId: () => "n2", now: () => "t" });
    expect(rows(db, "sk-1")).toHaveLength(1);
    expect(rows(db, "sk-2")).toHaveLength(1);
    expect(rows(db, "sk-1")[0].id).toBe("n1");
    expect(rows(db, "sk-2")[0].id).toBe("n2");
  });
});

/**
 * IL CARTELLO DEVE STARE NEL FILO — il difetto che ha reso invisibile tutto.
 *
 * La notifica nasceva senza `parent_id`, cioè come SECONDA RADICE della
 * conversazione. `loadActiveThread` cammina da una radice sola seguendo i rami
 * attivi: una seconda radice non viene mai raggiunta, quindi `/api/history` non
 * la serve e in chat non compare niente.
 *
 * Misurato sul DB di produzione il 20/08: dieci cartelli «Turno interrotto da
 * un riavvio» scritti in un giorno, ZERO visibili. Fra questi, quelli delle due
 * chat che l'utente vedeva ferme e mute — la segnalazione che ha aperto questa
 * indagine è letteralmente «non vedo nulla di nuovo e sono ancora fermate».
 *
 * Il test cammina il filo come fa il server, invece di guardare solo che la
 * riga esista: era proprio quella la differenza fra verde e visibile.
 */
describe("il cartello del riavvio è raggiungibile dal filo", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  /** Il filo, come lo costruisce `loadActiveThread`: dalla radice, di figlio in figlio. */
  const filo = (sessionKey: string): Array<{ id: string; content: string }> => {
    const righe = db.query(
      "SELECT id, parent_id, content FROM messages WHERE session_key = ? ORDER BY sort_order",
    ).all(sessionKey) as Array<{ id: string; parent_id: string | null; content: string }>;
    const figli = new Map<string | null, typeof righe>();
    for (const r of righe) {
      const k = r.parent_id;
      if (!figli.has(k)) figli.set(k, []);
      figli.get(k)!.push(r);
    }
    const out: Array<{ id: string; content: string }> = [];
    let cur: string | null = null;
    for (;;) {
      const c = figli.get(cur);
      if (!c || c.length === 0) break;
      out.push({ id: c[0].id, content: c[0].content });
      cur = c[0].id;
    }
    return out;
  };

  it("il cartello si legge camminando il filo, non solo interrogando la tabella", () => {
    db.run(
      "INSERT INTO messages (id, session_key, role, content, partial, timestamp, sort_order, parent_id) VALUES ('u1','topic:x','user','ciao',0,'t1',0,NULL)",
    );
    db.run(
      "INSERT INTO messages (id, session_key, role, content, partial, timestamp, sort_order, parent_id) VALUES ('a1','topic:x','assistant','sto lavorando',1,'t2',1,'u1')",
    );

    runBootPartialSweep(db, { listConfirmed: true, liveSessions: new Set() });

    const percorso = filo("topic:x");
    // Tre righe: la domanda, il lavoro interrotto, e il perché.
    expect(percorso.map((r) => r.id)).toEqual(["u1", "a1", percorso[2]?.id]);
    expect(percorso).toHaveLength(3);
    expect(percorso[2].content).toContain("riavvio del server");
  });

  it("il cartello si aggancia all'ULTIMA riga, non alla prima", () => {
    // Agganciarlo alla radice lo metterebbe come ramo parallelo del primo
    // messaggio: la conversazione lo salterebbe di nuovo.
    for (const [id, ord, parent] of [["u1", 0, null], ["a1", 1, "u1"], ["u2", 2, "a1"], ["a2", 3, "u2"]] as const) {
      db.run(
        `INSERT INTO messages (id, session_key, role, content, partial, timestamp, sort_order, parent_id)
         VALUES (?, 'topic:y', ?, 'x', ?, 't', ?, ?)`,
        [id, id.startsWith("u") ? "user" : "assistant", id === "a2" ? 1 : 0, ord, parent],
      );
    }
    runBootPartialSweep(db, { listConfirmed: true, liveSessions: new Set() });
    const percorso = filo("topic:y");
    expect(percorso).toHaveLength(5);
    expect(percorso[4].content).toContain("riavvio del server");
  });
});
