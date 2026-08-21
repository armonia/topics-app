/**
 * Le prove della regola in `verdetto-turno-interrotto.ts`.
 *
 * Il caso che conta è il primo: turno con prosa E tool interrotto. È la forma
 * NORMALE di un turno d'agente che muore — dice cosa sta per fare, chiama un
 * tool, e lì il server si spegne — ed è esattamente quella che lo spazzino
 * lasciava muta, perché guardava `hasProse` e trovava prosa.
 */
import { describe, expect, test } from "bun:test";
import { verdettoDaApporre } from "./verdetto-turno-interrotto";
import type { ContentBlock } from "../types";

const TESTO = "Turno interrotto: il server si è riavviato mentre la risposta era in corso.";
const tool = (error?: string, status = "error"): ContentBlock =>
  ({ kind: "tool", toolCall: { id: "t1", name: "bash", args: {}, status, ...(error ? { error } : {}) } }) as ContentBlock;

describe("verdetto su un turno interrotto", () => {
  test("prosa E tool interrotto: il verdetto ci va lo stesso", () => {
    const blocks: ContentBlock[] = [
      { kind: "text", text: "Misuro la densità, poi confronto." },
      tool("Interrotto: la sessione è terminata prima del risultato"),
    ];
    expect(verdettoDaApporre(blocks, TESTO)).toEqual({ kind: "error", text: TESTO });
  });

  test("anche il comando morto col turno conta come interruzione", () => {
    const blocks: ContentBlock[] = [tool("[comando interrotto: il turno è stato annullato mentre girava]")];
    expect(verdettoDaApporre(blocks, TESTO)).toEqual({ kind: "error", text: TESTO });
  });

  test("le tre penne che scrivono l'interruzione sono tutte riconosciute", () => {
    // `ORPHAN_ERRORS` (spazzino del boot), `utils.ts` (stream finito a vuoto),
    // `native/tools.ts` (comando ucciso dall'abort). Ne mancava una, e ha
    // lasciato muta una riga su 1175.
    for (const err of [
      "Interrotto: la sessione è terminata prima del risultato",
      "Interrotto: la sessione si è chiusa mentre la domanda era a schermo",
      "Interrotto: il turno è terminato senza risultato",
      "[comando interrotto: il turno è stato annullato mentre girava]",
    ]) {
      expect(verdettoDaApporre([tool(err)], TESTO)).toEqual({ kind: "error", text: TESTO });
    }
  });

  test("«interrotto» dentro l'output di un comando NON è un verdetto", () => {
    // Il prefisso è ancorato apposta: un test che stampa la parola non deve
    // far comparire «il server si è riavviato» su un turno sano.
    const blocks: ContentBlock[] = [tool("[exit 1]\nil processo è stato interrotto dal test")];
    expect(verdettoDaApporre(blocks, TESTO)).toBeNull();
  });

  test("chi ha già una spiegazione non ne riceve una seconda", () => {
    const blocks: ContentBlock[] = [
      tool("Interrotto: la sessione è terminata prima del risultato"),
      { kind: "error", text: "una spiegazione che c'era già" },
    ];
    expect(verdettoDaApporre(blocks, TESTO)).toBeNull();
  });

  test("un errore VERO del comando non è un'interruzione", () => {
    // `[exit 1]` è un test fallito, non un turno morto: spiegarlo con «il
    // server si è riavviato» sarebbe una bugia peggiore del silenzio.
    const blocks: ContentBlock[] = [tool("[exit 1]\ntest fallito")];
    expect(verdettoDaApporre(blocks, TESTO)).toBeNull();
  });

  test("un turno sano non viene toccato", () => {
    const blocks: ContentBlock[] = [
      { kind: "text", text: "fatto" },
      tool(undefined, "success"),
    ];
    expect(verdettoDaApporre(blocks, TESTO)).toBeNull();
  });

  test("niente blocchi, niente verdetto", () => {
    expect(verdettoDaApporre([], TESTO)).toBeNull();
    expect(verdettoDaApporre(null, TESTO)).toBeNull();
    expect(verdettoDaApporre(undefined, TESTO)).toBeNull();
  });

  test("è ripetibile: applicato due volte non accumula", () => {
    const blocks: ContentBlock[] = [tool("Interrotto: la sessione è terminata prima del risultato")];
    const primo = verdettoDaApporre(blocks, TESTO);
    expect(primo).not.toBeNull();
    blocks.push(primo!);
    // Secondo giro dello stesso boot, o boot successivo: niente da fare.
    expect(verdettoDaApporre(blocks, TESTO)).toBeNull();
  });
});

/**
 * LA BONIFICA SU UN DB VERO — perché la regola giusta applicata male non
 * ripara niente, e questo giro scrive sul database di produzione.
 *
 * Prova le tre cose che possono andare storte: che tocchi solo chi va toccato,
 * che i blocchi restino leggibili dopo il giro di compressione, e che ripassare
 * non accumuli cartelli.
 */
import { Database } from "bun:sqlite";
import { bonificaTurniMuti } from "./verdetto-turno-interrotto";
import { decodeCol, encodeCol } from "../../shared/message-blob";

function dbDiProva(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT, blocks BLOB, partial INTEGER, timestamp TEXT)`);
  return db;
}
const ora = new Date().toISOString();
const inserisci = (db: Database, id: string, blocks: unknown[], extra: Partial<{ role: string; partial: number; timestamp: string }> = {}) =>
  db.prepare(`INSERT INTO messages (id, role, blocks, partial, timestamp) VALUES (?,?,?,?,?)`).run(
    id, extra.role ?? "assistant", encodeCol(JSON.stringify(blocks)) ?? null, extra.partial ?? 0, extra.timestamp ?? ora,
  );

describe("bonifica dei turni muti", () => {
  test("ripara il muto, lascia stare tutti gli altri", () => {
    const db = dbDiProva();
    inserisci(db, "muto", [
      { kind: "text", text: "misuro" },
      { kind: "tool", toolCall: { id: "a", name: "bash", args: {}, status: "error", error: "Interrotto: il turno è terminato senza risultato" } },
    ]);
    inserisci(db, "sano", [{ kind: "text", text: "fatto" }]);
    inserisci(db, "gia-spiegato", [
      { kind: "tool", toolCall: { id: "b", name: "bash", args: {}, status: "error", error: "Interrotto: la sessione è terminata prima del risultato" } },
      { kind: "error", text: "spiegato prima" },
    ]);
    // Un turno ANCORA VIVO non si tocca: sta scrivendo adesso.
    inserisci(db, "in-volo", [
      { kind: "tool", toolCall: { id: "c", name: "bash", args: {}, status: "error", error: "Interrotto: il turno è terminato senza risultato" } },
    ], { partial: 1 });
    // Fuori finestra: la bonifica guarda gli ultimi 30 giorni.
    inserisci(db, "vecchio", [
      { kind: "tool", toolCall: { id: "d", name: "bash", args: {}, status: "error", error: "Interrotto: il turno è terminato senza risultato" } },
    ], { timestamp: "2020-01-01T00:00:00.000Z" });

    expect(bonificaTurniMuti(db as never, "TESTO DEL CARTELLO")).toBe(1);

    const leggi = (id: string) =>
      JSON.parse(decodeCol((db.query(`SELECT blocks FROM messages WHERE id=?`).get(id) as { blocks: unknown }).blocks) || "[]") as ContentBlock[];
    expect(leggi("muto").at(-1)).toEqual({ kind: "error", text: "TESTO DEL CARTELLO" });
    // La prosa dell'agente resta dov'era: il verdetto si aggiunge, non sostituisce.
    expect(leggi("muto")[0]).toEqual({ kind: "text", text: "misuro" });
    expect(leggi("sano").some((b) => b.kind === "error")).toBe(false);
    expect(leggi("gia-spiegato").filter((b) => b.kind === "error")).toHaveLength(1);
    expect(leggi("in-volo").some((b) => b.kind === "error")).toBe(false);
    expect(leggi("vecchio").some((b) => b.kind === "error")).toBe(false);
  });

  test("ripassare non accumula: il secondo giro non tocca niente", () => {
    const db = dbDiProva();
    inserisci(db, "muto", [
      { kind: "tool", toolCall: { id: "a", name: "bash", args: {}, status: "error", error: "Interrotto: il turno è terminato senza risultato" } },
    ]);
    expect(bonificaTurniMuti(db as never, "X")).toBe(1);
    expect(bonificaTurniMuti(db as never, "X")).toBe(0);
  });
});
