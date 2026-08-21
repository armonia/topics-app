/**
 * `getLastAgentText` — le parole dell'agente, non il cartello che ne annuncia
 * la morte.
 *
 * A COSA SERVE. Quando un turno finisce prima che l'agente possa chiamare
 * `comment_task`, il dispatcher rispecchia la sua ultima prosa nel thread della
 * card: chi rivede legge «cosa ho fatto» invece di trovarsi davanti una nota di
 * sistema. È la rete che impedisce a una card lavorata di arrivare muta.
 *
 * IL DIFETTO. Prendeva l'ultimo messaggio assistente QUALUNQUE FOSSE. Ma quando
 * un turno muore, il messaggio più recente è proprio il cartello che ne annuncia
 * la morte — «⚠️ Turno interrotto da un riavvio del server…» — quindi la rete
 * rispecchiava sulla card l'annuncio del guasto al posto del lavoro.
 *
 * Misurato sulla card `235afe11` (20/08): sotto quel cartello c'erano le parole
 * vere dell'agente, a due righe di distanza. La card è arrivata in review muta
 * con il testo buono lì sotto, e il difetto è ARRIVATO A SCHERMO: è la card che
 * mostrava «Fan-out chiuso: 3 tentativi» al posto di un riassunto.
 *
 * I due messaggi qui sotto sono quelli veri di `topic:85561235`.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { TURN_ERROR_PREFIX } from "../../shared/board";

/**
 * La regola di `getLastAgentText` (server.ts), isolata.
 *
 * Copiata e non importata perché lì è una closure dentro l'oggetto di
 * dipendenze del dispatcher, costruito con mezzo server attaccato. La regola è
 * tre righe: quello che conta è che il caso vero sia coperto, e questo file lo
 * nomina in modo che chi cambia la closure trovi il test cercando la frase.
 */
function ultimaProsaDellAgente(msgs: ReadonlyArray<{ role: string; content: unknown }>): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== "assistant" || typeof m.content !== "string") continue;
    const testo = m.content.trim();
    if (!testo) continue;
    if (testo.startsWith(TURN_ERROR_PREFIX)) continue;
    return m.content;
  }
  return null;
}

const CARTELLO = TURN_ERROR_PREFIX + " Turno interrotto da un riavvio del server. Il messaggio che hai inviato e' ancora qui: premi Riprova per inviarlo di nuovo.";
const PROSA = "I'll start by framing the work: reading the task and exploring the tab/browser code.";

describe("l'ultima prosa dell'agente", () => {
  /** IL CASO 235afe11, con i messaggi veri nell'ordine vero. */
  test("salta il cartello e trova le parole sotto", () => {
    const out = ultimaProsaDellAgente([
      { role: "user", content: "vai" },
      { role: "assistant", content: PROSA },
      { role: "assistant", content: CARTELLO },
    ]);
    expect(out).toBe(PROSA);
  });

  test("più cartelli di fila non fermano la discesa", () => {
    const out = ultimaProsaDellAgente([
      { role: "assistant", content: PROSA },
      { role: "assistant", content: "⚠️ Turno interrotto prima di una risposta finale." },
      { role: "assistant", content: CARTELLO },
    ]);
    expect(out).toBe(PROSA);
  });

  /**
   * Se sotto NON c'è niente, meglio null che il cartello: il dispatcher su
   * `null` scrive la sua nota di sistema, che è onesta. Rispecchiare il
   * cartello come «parole dell'agente» sarebbe un'attribuzione falsa.
   */
  test("solo cartelli: nessuna parola da rispecchiare", () => {
    expect(ultimaProsaDellAgente([{ role: "assistant", content: CARTELLO }])).toBeNull();
  });

  test("un turno sano non è toccato", () => {
    const out = ultimaProsaDellAgente([
      { role: "assistant", content: PROSA },
      { role: "assistant", content: "Fatto: tre file, typecheck verde." },
    ]);
    expect(out).toBe("Fatto: tre file, typecheck verde.");
  });

  /** Un ⚠️ in MEZZO alla prosa non è un cartello: solo l'inizio conta. */
  test("un ⚠️ dentro il testo non lo squalifica", () => {
    const con = "Fatto, ma ⚠️ attenzione al caso limite.";
    expect(ultimaProsaDellAgente([{ role: "assistant", content: con }])).toBe(con);
  });
});

/**
 * IL DUBBIO SOLLEVATO, e la misura che lo scioglie.
 *
 * Obiezione ricevuta: «il verdetto autorevole e' il BLOCCO `error`, il prefisso
 * e' legacy; un turno interrotto OGGI scrive il blocco e lascia `content`
 * vuoto, quindi la guardia sul prefisso non scatta e il difetto sopravvive per
 * tutti i turni futuri».
 *
 * Sarebbe grave se fosse vero, e va verificato sul database invece che
 * ragionato: `routes/chat.ts` ha DUE rami che assegnano `fullContent`, ed
 * entrambi scrivono il prefisso quando la riga sarebbe altrimenti vuota — per
 * una ragione dichiarata li' (e' l'unica colonna che la ricerca interroga, e i
 * client vecchi leggono da quella).
 *
 * Misurato il 20/08 sul DB vivo, righe assistente dal 18/08:
 *   · con blocco `error` e `content` VUOTO  →  0
 *   · con il prefisso in `content`          →  573
 * E sui soli turni dopo il fix di stasera: 6 su 6 col testo, zero vuoti.
 *
 * Quindi la guardia sul prefisso copre anche i turni nuovi. Questo test tiene
 * la misura viva: se un domani qualcuno smettesse di scrivere `content`, qui
 * comparirebbe un caso non coperto e si vedrebbe subito.
 */
describe("la forma dei cartelli, misurata sul database", () => {
  test("nessun turno interrotto lascia `content` vuoto col solo blocco", () => {
    let db: Database;
    try { db = new Database("data/topics.db", { readonly: true }); }
    catch { return; } // niente DB (CI pulita): il test non ha nulla da misurare
    const r = db.query(`
      SELECT
        SUM(CASE WHEN TRIM(COALESCE(content,'')) = '' AND blocks LIKE '%"kind":"error"%' THEN 1 ELSE 0 END) AS vuoti,
        SUM(CASE WHEN content LIKE ? THEN 1 ELSE 0 END) AS con_prefisso
      FROM messages WHERE role = 'assistant' AND timestamp > '2026-08-18'
    `).get(TURN_ERROR_PREFIX + "%") as { vuoti: number | null; con_prefisso: number | null };
    db.close();
    // Se questo diventasse > 0, la guardia sul prefisso non basterebbe piu' e
    // andrebbe letto il blocco (a costo di caricare ~20 KB per messaggio).
    expect(r.vuoti ?? 0).toBe(0);
    expect(r.con_prefisso ?? 0).toBeGreaterThan(0);
  });
});
