/**
 * IL VERDETTO SU UN TURNO CHE È MORTO SENZA DIRLO — deciso qui, non nel boot.
 *
 * ── Il guasto ───────────────────────────────────────────────────────────────
 * Lo spazzino del boot chiude i tool rimasti appesi e, se il turno non aveva
 * scritto NIENTE, gli mette in `content` un cartello che spiega perché. La
 * condizione era `hasProse`: prosa presente → nessuna spiegazione.
 *
 * Solo che un turno d'agente scrive quasi sempre qualcosa prima di morire — è
 * la sua forma normale: dice cosa sta per fare, chiama un tool, continua. Con
 * mezza frase a schermo il ramo `hasProse` taceva, e la riga restava una
 * risposta troncata a metà con una X rossa in fondo e nessun perché.
 *
 * Misurato sul DB di produzione il 20/08: 1082 turni, dal 1° agosto, con un
 * tool chiuso come «Interrotto» e nessun blocco che lo spiegasse.
 *
 * ── La regola ───────────────────────────────────────────────────────────────
 * Il verdetto va nei BLOCCHI, che sono ciò che il client disegna, e non tocca
 * `content`: la prosa già scritta è lavoro dell'agente e resta sua. Il blocco
 * `error` si rende in cima alla bolla (`ContentBlock`, `shared/types.ts`) ed è
 * la stessa strada che `finalizeStream` usa sul cammino vivo — qui si ripara
 * ciò che quel cammino non ha fatto in tempo a scrivere, perché il processo era
 * già uscito.
 *
 * Idempotente per costruzione: una riga che un verdetto ce l'ha già non si
 * tocca. Chi aveva scritto una spiegazione, la sua è migliore della nostra.
 */
import type { ContentBlock } from "../types";
import { decodeCol, encodeCol } from "../../shared/message-blob";

/**
 * Come si riconosce un tool che è morto CON il turno, e non per colpa sua.
 *
 * Sono tre le penne che scrivono questi testi — `ORPHAN_ERRORS` (lo spazzino
 * del boot), `utils.ts` (la chiusura di uno stream finito a vuoto) e ora
 * `native/tools.ts` (il comando ucciso dall'abort) — e tutte e tre aprono con
 * la stessa parola. Si guarda il TESTO e non lo stato, perché a quel punto lo
 * stato è `error` come per mille errori veri: un `[exit 1]` è un test fallito,
 * e spiegarlo con «il server si è riavviato» sarebbe una bugia peggiore del
 * silenzio.
 *
 * Il prefisso è ancorato: un errore che CONTIENE la parola più in là (l'output
 * di un comando che parla di interruzioni) non deve entrare.
 */
const SIGNS_OF_INTERRUPTION = /^Interrotto[:,] |^\[comando interrotto:/;

/**
 * Il cartello per una riga chiusa dallo spazzino, o `null` se non serve.
 *
 * `null` significa: o non è un turno interrotto, o qualcuno ha già spiegato.
 * In entrambi i casi la riga non va riscritta — e questo è ciò che rende la
 * bonifica ripetibile a ogni boot senza accumulare cartelli.
 */
export function verdettoDaApporre(
  blocks: ContentBlock[] | null | undefined,
  testo: string,
): ContentBlock | null {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  // Già spiegato: la sua versione vince sulla nostra.
  if (blocks.some((b) => b?.kind === "error")) return null;
  const interrotto = blocks.some(
    (b) =>
      b?.kind === "tool" &&
      typeof (b as { toolCall?: { error?: unknown } }).toolCall?.error === "string" &&
      SIGNS_OF_INTERRUPTION.test((b as { toolCall: { error: string } }).toolCall.error),
  );
  if (!interrotto) return null;
  return { kind: "error", text: testo };
}

/**
 * Passa sulle righe recenti e mette il verdetto a chi è morto senza dirlo.
 *
 * Vive QUI e non nel boot per la stessa ragione della regola: dentro `server.ts`
 * nessuno ci arriva con un test, e questo giro tocca il DB di produzione. Il
 * chiamante passa il testo del cartello, così la formulazione resta una sola
 * cosa sola, decisa da `cancelledNotice`.
 *
 * Ripetibile a ogni boot senza accumulare: `verdettoDaApporre` scarta chi ha
 * già un verdetto. Restituisce quante righe ha riparato.
 */
export function bonificaTurniMuti(db: DbLike, testo: string): number {
  const iter = db.prepare(
    `SELECT id, blocks FROM messages WHERE role = 'assistant'
       AND blocks IS NOT NULL AND partial = 0
       AND timestamp >= date('now', '-30 days')`,
  ).iterate() as Iterable<{ id: string; blocks: unknown }>;
  // Si raccoglie PRIMA di scrivere: aggiornare la tabella che si sta scorrendo
  // è un comportamento che SQLite non definisce.
  const toRepair: Array<{ id: string; blocks: string }> = [];
  for (const row of iter) {
    const bl = decodeCol(row.blocks);
    // Scarto a buon mercato prima di pagare il `JSON.parse`: le righe con un
    // tool interrotto sono poche, quelle da scorrere sono decine di migliaia.
    if (!bl || !bl.includes("nterrotto")) continue;
    let parsed: ContentBlock[];
    try { parsed = JSON.parse(bl) as ContentBlock[]; } catch { continue; }
    const verdetto = verdettoDaApporre(parsed, testo);
    if (!verdetto) continue;
    parsed.push(verdetto);
    toRepair.push({ id: row.id, blocks: JSON.stringify(parsed) });
  }
  if (toRepair.length === 0) return 0;
  const upd = db.prepare(`UPDATE messages SET blocks = ? WHERE id = ?`);
  for (const r of toRepair) upd.run(encodeCol(r.blocks) ?? null, r.id);
  console.log(`[boot] ${toRepair.length} turno/i interrotto/i senza spiegazione: verdetto aggiunto`);
  return toRepair.length;
}

/**
 * Quel poco di `Database` che serve qui.
 *
 * Non si importa il tipo di `bun:sqlite`: questa funzione ha bisogno di due
 * verbi, e chiederne l'intera superficie legherebbe una regola a un driver.
 */
interface DbLike {
  // `any` non per pigrizia: `bun:sqlite` tipizza `prepare` con generici che
  // vincolano il chiamante a dichiarare la forma della riga, e riscriverli qui
  // vorrebbe dire copiare il driver dentro una regola. Le due righe che li
  // usano, sotto, dicono la forma vera.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prepare(sql: string): any; // allow-any: il driver tipizza `prepare` con generici che obbligherebbero questa regola a dichiarare la forma di ogni riga
}
