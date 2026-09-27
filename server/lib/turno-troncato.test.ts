/**
 * Le prove di `turno-troncato.ts`.
 *
 * Il «sì» è uno: un turno che stava lavorando quando il server è morto. I «no»
 * sono la parte che conta — senza di essi, OGNI chat sana si prenderebbe un
 * «turno interrotto» a ogni riavvio, e il cartello smetterebbe di voler dire
 * qualcosa proprio mentre lo si scrive dappertutto.
 *
 * @covers INTERRUPT-01
 */
import { describe, expect, test } from "bun:test";
import { closeReattachedRows, èTroncato, TURNO_TRONCATO, spiegaTurnoTroncato } from "./turno-troncato";
import type { ContentBlock } from "../types";
import { Database } from "bun:sqlite";
import { decodeCol, encodeCol } from "../../shared/message-blob";

const tool = (): ContentBlock =>
  ({ kind: "tool", toolCall: { id: "t", name: "Bash", args: {}, status: "success" } }) as ContentBlock;
const testo = (t = "ecco fatto"): ContentBlock => ({ kind: "text", text: t });

describe("chi è stato troncato", () => {
  test("finiva su un tool: stava lavorando, quindi è stato tagliato", () => {
    expect(èTroncato("assistant", [testo("sto misurando"), tool()])).toBe(true);
  });

  test("finiva parlando: è il modo normale di finire", () => {
    // Questo è il freno che tiene tutto: senza, ogni chat sana prende un
    // cartello a ogni riavvio del server.
    expect(èTroncato("assistant", [tool(), testo()])).toBe(false);
  });

  test("ha già una spiegazione: non se ne aggiunge una seconda", () => {
    expect(èTroncato("assistant", [tool(), { kind: "error", text: "già spiegato" }])).toBe(false);
  });

  test("non è dell'assistente, o non ha blocchi: non si decide niente", () => {
    expect(èTroncato("user", [tool()])).toBe(false);
    expect(èTroncato("assistant", [])).toBe(false);
    expect(èTroncato("assistant", null)).toBe(false);
  });
});

describe("il cartello finisce davvero sulla riga", () => {
  const dbDiProva = () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT, role TEXT, blocks BLOB, sort_order INTEGER)`);
    return db;
  };
  const inserisci = (db: Database, id: string, role: string, blocks: ContentBlock[], ord: number) =>
    db.prepare(`INSERT INTO messages (id, session_key, role, blocks, sort_order) VALUES (?, 'topic:x', ?, ?, ?)`)
      .run(id, role, encodeCol(JSON.stringify(blocks)) ?? null, ord);
  const leggi = (db: Database, id: string) =>
    JSON.parse(decodeCol((db.query(`SELECT blocks FROM messages WHERE id=?`).get(id) as { blocks: unknown }).blocks) ?? "[]") as ContentBlock[];

  test("scrive sull'ULTIMA riga, e solo se serve", () => {
    const db = dbDiProva();
    inserisci(db, "vecchia", "assistant", [tool(), testo()], 0);
    inserisci(db, "ultima", "assistant", [testo("sto misurando"), tool()], 1);

    expect(spiegaTurnoTroncato(db as never, "topic:x")).toBe(true);
    expect(leggi(db, "ultima").at(-1)).toEqual({ kind: "error", text: TURNO_TRONCATO });
    // La riga di prima non si tocca: è finita bene ed è storia.
    expect(leggi(db, "vecchia").some((b) => b.kind === "error")).toBe(false);
  });

  test("ripetibile: alla seconda passata non scrive più", () => {
    const db = dbDiProva();
    inserisci(db, "a", "assistant", [testo("lavoro"), tool()], 0);
    expect(spiegaTurnoTroncato(db as never, "topic:x")).toBe(true);
    expect(spiegaTurnoTroncato(db as never, "topic:x")).toBe(false);
    expect(leggi(db, "a").filter((b) => b.kind === "error")).toHaveLength(1);
  });

  test("una sessione che non esiste non fa esplodere il boot", () => {
    const db = dbDiProva();
    expect(spiegaTurnoTroncato(db as never, "topic:mai-vista")).toBe(false);
  });
});

/**
 * A REATTACH LEG THAT CLOSES ITS ROWS TELLS THE OPEN WINDOWS (card edf3c4db).
 *
 * At the end of a reattach leg, after the boot, the rows the turn left open
 * were closed and the cut explained in the database only: a window open on
 * the chat kept the bubble as it was, still open and with no notice, until a
 * reload.
 */
describe("closing the rows a reattach leg left open", () => {
  const withRows = () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT, role TEXT, blocks BLOB, sort_order INTEGER, partial INTEGER, streamed_at TEXT)`);
    return db;
  };
  const add = (db: Database, id: string, blocks: ContentBlock[], partial: number) =>
    db.prepare(`INSERT INTO messages (id, session_key, role, blocks, sort_order, partial, streamed_at) VALUES (?, 'topic:x', 'assistant', ?, 0, ?, ?)`)
      .run(id, encodeCol(JSON.stringify(blocks)) ?? null, partial, partial ? new Date().toISOString() : null);

  test("a row cut on a tool is closed, explained, and the open windows are told once", () => {
    const db = withRows();
    add(db, "cut", [testo("sto misurando"), tool()], 1);
    const told: string[] = [];
    expect(closeReattachedRows(db as never, "topic:x", (sk) => told.push(sk))).toBe(1);
    const row = db.query(`SELECT partial, streamed_at, blocks FROM messages WHERE id = 'cut'`).get() as { partial: number; streamed_at: string | null; blocks: unknown };
    expect(row.partial).toBe(0);
    expect(row.streamed_at).toBeNull();
    expect((JSON.parse(decodeCol(row.blocks) ?? "[]") as ContentBlock[]).at(-1)).toEqual({ kind: "error", text: TURNO_TRONCATO });
    expect(told).toEqual(["topic:x"]);
  });

  test("nothing left open: nothing written, nobody told", () => {
    const db = withRows();
    add(db, "done", [testo("sto misurando"), tool()], 0);
    const told: string[] = [];
    expect(closeReattachedRows(db as never, "topic:x", (sk) => told.push(sk))).toBe(0);
    expect(told).toEqual([]);
  });
});
