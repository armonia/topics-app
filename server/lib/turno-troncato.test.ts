/**
 * Le prove di `turno-troncato.ts`.
 *
 * Il «sì» è uno: un turno che stava lavorando quando il server è morto. I «no»
 * sono la parte che conta — senza di essi, OGNI chat sana si prenderebbe un
 * «turno interrotto» a ogni riavvio, e il cartello smetterebbe di voler dire
 * qualcosa proprio mentre lo si scrive dappertutto.
 */
import { describe, expect, test } from "bun:test";
import { èTroncato, TURNO_TRONCATO, spiegaTurnoTroncato } from "./turno-troncato";
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
