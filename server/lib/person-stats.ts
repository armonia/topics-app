/**
 * QUANTO LAVORA una persona: quanti prompt scrive e quanti token consuma.
 *
 * Si legge dalle colonne che la 095 ha aggiunto a `messages`, e la parte da
 * spiegare è la seconda: i token NON stanno sulla riga di chi scrive.
 *
 * Un messaggio utente non ha usage — è la RISPOSTA a portare
 * `usage_prompt_tokens` e `usage_completion_tokens`, perché è lì che il
 * provider li riporta. Quindi «i token di Mircea» sono la somma dell'usage
 * delle risposte APPESE ai suoi prompt: la giunzione è `parent_id`, che
 * l'albero dei messaggi (migration 005) mantiene già e che ha il suo indice.
 *
 * IL CONFINE, detto una volta: questo NON è «quanto costa Mircea
 * all'azienda». Un turno agentico lungo appende una sola risposta al prompt che
 * l'ha avviato, e tutto ciò che l'agente fa dopo — sotto-agenti, riletture,
 * cicli di tool — non passa da qui. È «quanto pesa il suo turno», che è la
 * domanda a cui un profilo può rispondere onestamente.
 *
 * Le righe SENZA autore non entrano da nessuna parte: `author_person_id IS
 * NULL` vuol dire «non lo sappiamo», e sommarle a qualcuno sarebbe inventare.
 */
import type { Database } from "bun:sqlite";

type Db = Pick<Database, "query">;

export interface StatistichePersona {
  /** Messaggi utente attribuiti a questa persona. */
  prompts: number;
  /** Token in ingresso delle risposte ai suoi prompt (cache inclusa: è ciò che il provider riporta). */
  inputTokens: number;
  /** Token generati in risposta ai suoi prompt. */
  outputTokens: number;
  /** Costo in centesimi di dollaro, per quanto il server l'ha saputo calcolare. */
  costCents: number;
  /** Timestamp ISO dell'ultimo prompt, o null se non ne ha mai scritto uno. */
  ultimoPrompt: string | null;
}

const VUOTE: StatistichePersona = {
  prompts: 0, inputTokens: 0, outputTokens: 0, costCents: 0, ultimoPrompt: null,
};

export function statistichePersona(db: Db, personId: string): StatistichePersona {
  try {
    const p = db.query(`
      SELECT COUNT(*) AS n, MAX(timestamp) AS ultimo
        FROM messages
       WHERE role = 'user' AND author_person_id = ?`).get(personId) as
      { n: number; ultimo: string | null } | undefined;

    const u = db.query(`
      SELECT COALESCE(SUM(a.usage_prompt_tokens), 0)     AS input,
             COALESCE(SUM(a.usage_completion_tokens), 0) AS output,
             COALESCE(SUM(a.cost_cents), 0)              AS cents
        FROM messages a
        JOIN messages u ON u.id = a.parent_id
       WHERE a.role = 'assistant'
         AND u.role = 'user'
         AND u.author_person_id = ?`).get(personId) as
      { input: number; output: number; cents: number } | undefined;

    return {
      prompts: Number(p?.n ?? 0),
      inputTokens: Number(u?.input ?? 0),
      outputTokens: Number(u?.output ?? 0),
      costCents: Number(u?.cents ?? 0),
      ultimoPrompt: p?.ultimo ?? null,
    };
  } catch {
    // Schema anteriore alla 095: si consegnano zeri invece di far cadere la
    // schermata dei profili. Uno zero qui si legge «non ne ha fatti», che su un
    // database senza la colonna è vero quanto qualunque altra cosa.
    return { ...VUOTE };
  }
}
