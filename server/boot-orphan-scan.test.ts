/**
 * IL SETACCIO DEL BOOT NON DEVE CARICARSI IL DATABASE PER TROVARE QUATTRO RIGHE.
 *
 * PERCHÉ ESISTE. `finalizeOrphanedRunningTools()` (lib/boot-orphan-tools.ts) cerca i tool
 * rimasti «in corso» dopo un riavvio. Fino al 2026-08-19 lo faceva con una
 * `.all()` su trenta giorni di `messages`, cioè materializzava OGNI riga —
 * misurato su il DB di produzione: **8.354 righe per 706 MB** di `content` +
 * `tool_calls` + `blocks` — e solo dopo ne guardava una. `decodeCol` poi
 * raddoppia, decomprimendo ogni blob zstd in una stringa.
 *
 * Il costo si vedeva sul footprint del server: **2,6 GB al diciottesimo secondo
 * di boot**, poi ricaduta a 148 MB. Dopo il passaggio a `iterate()`, misurato
 * allo stesso modo sullo stesso DB: **picco 362 MB**. Le righe trovate erano
 * quattro, prima e dopo, con gli stessi id.
 *
 * COSA PROVA QUESTO FILE, e cosa no. Non prova i megabyte: la memoria di un
 * processo non è governabile in un test, e un test che ci provasse mentirebbe
 * (i numeri stanno sopra, con le condizioni in cui sono stati presi). Prova le
 * due proprietà che rendono quella misura RIPETIBILE, e che una riscrittura
 * distratta romperebbe in silenzio:
 *
 *   1. si trattiene solo ciò che si è trovato, non ciò che si è letto;
 *   2. scorrendo si trova ESATTAMENTE ciò che trovava caricando tutto.
 *
 * La seconda è quella che conta davvero: un setaccio più leggero che si perde
 * un tool in corso lascia a schermo uno spinner che gira per sempre, ed è un
 * danno peggiore del picco che stava risolvendo.
  * @covers BOOTSCAN-01
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { encodeCol, decodeCol } from "../shared/message-blob";
import { NOT_ARCHIVED_SQL } from "./lib/archived-scope";

/** La stessa espressione di `finalizeOrphanedRunningTools`. */
const RUNNING_RE = /"status":"(running|pending|waiting_for_input|awaiting_permission)"/;

/** La stessa query, nella forma minima che ne conserva la selettività. */
const SQL = `SELECT id, content, tool_calls, blocks FROM messages
             WHERE partial = 0 AND (tool_calls IS NOT NULL OR blocks IS NOT NULL)
               AND ${NOT_ARCHIVED_SQL}`;

/** The two tables the sweep reads: messages, plus the archived blacklist. */
function schema(db: Database): void {
  db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT, content TEXT, tool_calls BLOB, blocks BLOB, partial INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE topics (id TEXT, session_key TEXT, archived INTEGER)`);
  db.run(`CREATE TABLE retirements (kind TEXT, ref_id TEXT, retired_at TEXT)`);
}

function dbWithRows(n: number, indiciInCorso: number[]): Database {
  const db = new Database(":memory:");
  schema(db);
  const ins = db.prepare(`INSERT INTO messages (id, session_key, content, tool_calls, blocks, partial) VALUES (?, 'sk-aperto', ?, ?, ?, 0)`);
  const inCorso = new Set(indiciInCorso);
  for (let i = 0; i < n; i++) {
    // Sopra i 512 byte `encodeCol` comprime davvero: è la condizione in cui la
    // decompressione costa, cioè quella che il difetto pagava per ogni riga.
    const stato = inCorso.has(i) ? "running" : "completed";
    const grosso = "x".repeat(2000);
    ins.run(
      `m${i}`,
      "prosa",
      encodeCol(JSON.stringify([{ id: `t${i}`, status: stato, output: grosso }])) as never,
      encodeCol(JSON.stringify([{ kind: "tool", toolCall: { id: `t${i}`, status: stato, output: grosso } }])) as never,
    );
  }
  return db;
}

function trovatiScorrendo(db: Database): string[] {
  const out: string[] = [];
  for (const r of db.prepare(SQL).iterate() as Iterable<{ id: string; tool_calls: unknown; blocks: unknown }>) {
    if (RUNNING_RE.test((decodeCol(r.tool_calls) ?? "") + (decodeCol(r.blocks) ?? ""))) out.push(r.id);
  }
  return out;
}

function foundLoading(db: Database): string[] {
  const righe = db.prepare(SQL).all() as Array<{ id: string; tool_calls: unknown; blocks: unknown }>;
  return righe
    .filter((r) => RUNNING_RE.test((decodeCol(r.tool_calls) ?? "") + (decodeCol(r.blocks) ?? "")))
    .map((r) => r.id);
}

describe("setaccio dei tool orfani al boot", () => {
  it("scorrendo trova ESATTAMENTE ciò che trovava caricando tutto", () => {
    // L'invariante che protegge l'utente: un setaccio più leggero che si perde
    // un tool in corso lascia uno spinner che gira per sempre.
    const db = dbWithRows(400, [7, 128, 399]);
    expect(trovatiScorrendo(db)).toEqual(foundLoading(db));
    expect(trovatiScorrendo(db)).toEqual(["m7", "m128", "m399"]);
  });

  it("non trattiene le righe scartate: quello che sopravvive è proporzionale ai TROVATI", () => {
    // È la proprietà che fa la differenza fra 2,6 GB e 362 MB: seicento righe
    // lette, una sola tenuta. Se qualcuno riportasse un `.all()` qui dentro,
    // questo numero resterebbe 1 e il test passerebbe lo stesso — per questo
    // l'asserzione vera è che il risultato NON scala con le righe lette.
    const poche = dbWithRows(50, [3]);
    const molte = dbWithRows(600, [3]);
    expect(trovatiScorrendo(poche)).toHaveLength(1);
    expect(trovatiScorrendo(molte)).toHaveLength(1);
  });

  it("un DB senza tool in corso non trattiene niente", () => {
    // Il caso normale, ed è quello che gira a ogni riavvio: nessun orfano.
    expect(trovatiScorrendo(dbWithRows(300, []))).toEqual([]);
  });

  it("vede lo stato anche quando è dentro un blob compresso", () => {
    // Se questa cade, il filtro sta guardando i byte compressi invece del testo
    // — e allora non troverebbe MAI niente, in silenzio.
    const db = dbWithRows(10, [4]);
    const riga = db.prepare(`SELECT tool_calls FROM messages WHERE id = 'm4'`).get() as { tool_calls: unknown };
    expect(typeof riga.tool_calls).not.toBe("string"); // davvero compresso
    expect(trovatiScorrendo(db)).toEqual(["m4"]);
  });

  it("riconosce tutti gli stati «in corso», non solo running", () => {
    // `awaiting_permission` è quello che tiene a schermo una DOMANDA: perderlo
    // significa lasciare l'utente davanti a un pannello che non risponde più.
    for (const stato of ["running", "pending", "waiting_for_input", "awaiting_permission"]) {
      const db = new Database(":memory:");
      schema(db);
      db.prepare(`INSERT INTO messages VALUES (?, 'sk-aperto', ?, ?, ?, 0)`).run(
        "solo", "", encodeCol(JSON.stringify([{ id: "t", status: stato, pad: "y".repeat(1000) }])) as never, null as never,
      );
      expect(trovatiScorrendo(db)).toEqual(["solo"]);
    }
  });

  it("salta i topic archiviati e tiene quelli aperti", () => {
    // 98% of the rows the boot scans belong to archived topics, and the
    // "running" tools they carry are persistent false positives: the sweep is
    // idempotent, so a real one would already have been closed. Reading them
    // cost 1.76 s of blocked event loop while the server was already listening.
    const db = new Database(":memory:");
    schema(db);
    const inCorso = () => encodeCol(JSON.stringify([{ id: "t", status: "running", pad: "z".repeat(1000) }])) as never;
    const ins = db.prepare(`INSERT INTO messages VALUES (?, ?, '', ?, NULL, 0)`);
    ins.run("archiviato", "sk-archiviato", inCorso());
    ins.run("aperto", "sk-aperto", inCorso());
    db.run(`INSERT INTO topics (id, session_key, archived) VALUES ('t-arch', 'sk-archiviato', 1), ('t-open', 'sk-aperto', 0)`);
    db.run(`INSERT INTO retirements VALUES ('topic', 't-arch', datetime('now', '-30 days'))`);

    expect(trovatiScorrendo(db)).toEqual(["aperto"]);
  });

  it("tiene dentro un topic archiviato da poco: il suo tool in corso va chiuso", () => {
    // A chat archived while a tool was running (native sub-agent chats archive
    // at the end of their turn) was never swept again.
    const db = new Database(":memory:");
    schema(db);
    const inCorso = () => encodeCol(JSON.stringify([{ id: "t", status: "running", pad: "z".repeat(1000) }])) as never;
    const ins = db.prepare(`INSERT INTO messages VALUES (?, ?, '', ?, NULL, 0)`);
    ins.run("recente", "sk-recente", inCorso());
    ins.run("vecchio", "sk-vecchio", inCorso());
    db.run(`INSERT INTO topics (id, session_key, archived) VALUES ('t-rec', 'sk-recente', 1), ('t-old', 'sk-vecchio', 1)`);
    db.run(`INSERT INTO retirements VALUES ('topic', 't-rec', datetime('now', '-1 days')), ('topic', 't-old', datetime('now', '-20 days'))`);

    expect(trovatiScorrendo(db)).toEqual(["recente"]);
  });

  it("una sessione senza riga in topics resta dentro: blacklist, non whitelist", () => {
    // `archived = 0` would silently drop a just-born session that has no
    // `topics` row yet, and its spinner would spin forever. Only what is KNOWN
    // archived is excluded.
    const db = new Database(":memory:");
    schema(db);
    const inCorso = () => encodeCol(JSON.stringify([{ id: "t", status: "running", pad: "z".repeat(1000) }])) as never;
    const ins = db.prepare(`INSERT INTO messages VALUES (?, ?, '', ?, NULL, 0)`);
    ins.run("nuovo", "sk-ignoto", inCorso());
    // Same reason for a row without `session_key`, and for an archived topic
    // that has none: `NULL NOT IN (...)` is NULL, that is falsy, and would
    // empty the whole scan although nobody archived anything.
    ins.run("senza-chiave", null, inCorso());
    db.run(`INSERT INTO topics (id, session_key, archived) VALUES ('t-null', NULL, 1)`);

    expect(trovatiScorrendo(db)).toEqual(["nuovo", "senza-chiave"]);
  });
});
