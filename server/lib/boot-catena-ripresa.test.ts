/**
 * IL BOOT COMPLETO: chiudere il turno morto, spiegarlo, e riprenderlo.
 *
 * Ognuno dei tre pezzi ha i suoi test, ed erano tutti verdi mentre l'utente
 * guardava due chat ferme e mute. Il difetto stava NEL PASSAGGIO fra loro:
 *
 *   · `spiegaTurnoTroncato` scrive il verdetto sulla riga tagliata;
 *   · `chatDaRiprendere` decide chi riprendere GUARDANDO quel verdetto.
 *
 * Se il primo non scrive — o scrive in un posto che il secondo non legge — la
 * catena si spezza senza che nessun test se ne accorga: entrambi restano verdi
 * e la chat resta ferma. È esattamente com'è andata il 20/08, e questo file
 * esiste per rendere quella combinazione impossibile.
 *
 * @covers RESUME-02
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spiegaTurnoTroncato } from "./turno-troncato";
import { chatDaRiprendere, MAX_RESUME_ATTEMPTS } from "./ripresa-boot";
import type { ContentBlock } from "../types";
import { decodeCol, encodeCol } from "../../shared/message-blob";

const tool = (): ContentBlock =>
  ({ kind: "tool", toolCall: { id: "t", name: "Bash", args: {}, status: "success" } }) as ContentBlock;

function dbWithTruncatedTurn(blocks: ContentBlock[]): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT, role TEXT, blocks BLOB, sort_order INTEGER)`);
  db.prepare(`INSERT INTO messages VALUES ('u1','topic:x','user',NULL,0)`).run();
  db.prepare(`INSERT INTO messages VALUES ('a1','topic:x','assistant',?,1)`)
    .run(encodeCol(JSON.stringify(blocks)) ?? null);
  return db;
}
const blocchi = (db: Database, id: string): ContentBlock[] =>
  JSON.parse(decodeCol((db.query(`SELECT blocks FROM messages WHERE id=?`).get(id) as { blocks: unknown }).blocks) ?? "[]");

describe("dal turno tagliato alla ripresa, senza buchi in mezzo", () => {
  test("un turno morto sotto un tool: viene spiegato E poi ripreso", () => {
    const db = dbWithTruncatedTurn([{ kind: "text", text: "sto misurando" }, tool()]);

    // 1. Il boot chiude e SPIEGA.
    expect(spiegaTurnoTroncato(db as never, "topic:x")).toBe(true);

    // 2. La ripresa, che gira dopo, riconosce quel verdetto e lo riprende.
    const b = blocchi(db, "a1");
    expect(chatDaRiprendere(
      { sessionKey: "topic:x", ruolo: "assistant", blocks: b, timestampMs: Date.now() },
      Date.now(),
    )).toBe(true);
  });

  test("senza la spiegazione la ripresa NON scatta: è il buco del 20/08", () => {
    // Stesso turno, ma nessuno l'ha spiegato. La ripresa non ha appigli e la
    // chat resta ferma per sempre — che è ciò che l'utente ha visto.
    const b: ContentBlock[] = [{ kind: "text", text: "sto misurando" }, tool()];
    expect(chatDaRiprendere(
      { sessionKey: "topic:x", ruolo: "assistant", blocks: b, timestampMs: Date.now() },
      Date.now(),
    )).toBe(false);
  });

  test("un turno finito bene non viene né spiegato né ripreso", () => {
    const db = dbWithTruncatedTurn([tool(), { kind: "text", text: "fatto, ecco il risultato" }]);
    expect(spiegaTurnoTroncato(db as never, "topic:x")).toBe(false);
    expect(chatDaRiprendere(
      { sessionKey: "topic:x", ruolo: "assistant", blocks: blocchi(db, "a1"), timestampMs: Date.now() },
      Date.now(),
    )).toBe(false);
  });

  test("i boot di fila non riprendono lo stesso turno all'infinito", () => {
    const db = dbWithTruncatedTurn([{ kind: "text", text: "lavoro" }, tool()]);
    spiegaTurnoTroncato(db as never, "topic:x");
    // The resume marks the turn, and the trace is COUNTED, not a switch: one cut
    // resend must not close the door, because a resend cut by a server restart
    // was burning the row's single chance and leaving the chat stuck forever
    // under a notice promising it would resume on its own. Measured on
    // topic:0299ac2d, reported four times.
    const con = (n: number) => [
      ...blocchi(db, "a1"),
      ...Array.from({ length: n }, () => ({ kind: "ripreso" }) as ContentBlock),
    ];
    const valuta = (b: ContentBlock[]) => chatDaRiprendere(
      { sessionKey: "topic:x", ruolo: "assistant", blocks: b, timestampMs: Date.now() },
      Date.now(),
    );
    expect(valuta(con(1))).toBe(true);
    // What this case has always protected: the loop stays impossible.
    expect(valuta(con(MAX_RESUME_ATTEMPTS))).toBe(false);
    // E nemmeno la spiegazione si ripete.
    expect(spiegaTurnoTroncato(db as never, "topic:x")).toBe(false);
  });
});
