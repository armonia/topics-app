/**
 * authorDisplay.ts — dall'IDENTITÀ di chi ha scritto al NOME che si legge.
 *
 * `shared/comment-author.ts` risolve l'identità: `user`, `system`, `dispatcher`,
 * `verifier`, oppure `agent:<topicId>` → `agent 3f8a92cd`. È un'identità giusta,
 * ed è quella che deve restare sul disco e nelle risposte dell'MCP. Ma sullo
 * schermo produceva tre cose che nessuno può leggere:
 *
 *   «user»        — l'app SA come si chiama chi la usa, e lo firmava «user»;
 *   «dispatcher»  — il nome del pezzo di codice che ha scritto la riga, non di
 *                   chi ha agito: dal di fuori è l'app che ha mosso la scheda;
 *   «agent 3f8a92cd» — otto caratteri di uuid dove va un nome. Il codice non
 *                   dice niente a chi legge, e a chi debugga serve intero.
 *
 * Qui l'identità diventa un nome. La regola è che il NOME sta sullo schermo e
 * l'IDENTITÀ sta nel tooltip: niente si perde, e la riga si legge.
 *
 * Il modulo è puro — identità + nome del proprietario + traduttore in ingresso,
 * un record in uscita. Il nome del proprietario lo porta chi chiama
 * (`useOwnerName`), perché una funzione che va a prenderselo da sola non si può
 * provare senza rete.
 */
import type { CommentAuthorLabel, CommentAuthorKind } from '../../../shared/comment-author';

export type { CommentAuthorKind };

/** Come si legge chi ha scritto, e cosa dice il tooltip sopra di lui. */
export interface AuthorDisplay {
  /** Il nome sullo schermo. Mai un codice, mai vuoto. */
  name: string;
  /** L'identità per esteso: ruolo grezzo o id completo dell'agent. Va nel
   *  `title`, dove serve a chi sta cercando una riga nel database. */
  detail: string;
  kind: CommentAuthorKind;
  /** Vero quando chi ha parlato sei tu: la bolla si allinea a destra. */
  self: boolean;
}

/** Le chiavi i18n dei nomi, una per identità. Esportate perché i test le
 *  controllino contro il dizionario invece di riscriverle a mano. */
export const AUTHOR_NAME_KEYS: Record<CommentAuthorKind, string> = {
  user: 'board.task.author.you',
  system: 'board.task.author.app',
  dispatcher: 'board.task.author.app',
  verifier: 'board.task.author.verifier',
  agent: 'board.task.author.agent',
};

/**
 * Il nome da stampare per un'identità.
 *
 * `ownerName` è come si chiama chi possiede l'installazione (`/api/profile/owner`).
 * Quando c'è, le TUE righe portano il tuo nome; quando non c'è si ripiega su
 * «Tu», che è comunque una persona e non un ruolo di sistema.
 *
 * `system` e `dispatcher` collassano sullo stesso nome di proposito: la
 * differenza fra «il server ha scritto» e «la coda ha scritto» è una divisione
 * interna al codice, e chi legge la scheda vede una cosa sola — l'app che ha
 * agito da sé. Il ruolo esatto resta in `detail`.
 */
export function authorDisplay(
  who: CommentAuthorLabel,
  tr: (key: string, vars?: Record<string, string | number>) => string,
  ownerName?: string | null,
): AuthorDisplay {
  const kind = who.kind;
  if (kind === 'user') {
    const name = ownerName?.trim() || tr(AUTHOR_NAME_KEYS.user);
    return { name, detail: 'user', kind, self: true };
  }
  if (kind === 'agent') {
    // Un nome vero scritto dall'agent (`looksLikeName` l'ha già promosso) resta
    // suo. Solo la forma `agent <esadecimale>` — e il generico «agent» — passa
    // alla parola tradotta: il codice non dice niente a chi guarda la scheda.
    const coded = who.agentId !== null || who.label === 'agent';
    return {
      name: coded ? tr(AUTHOR_NAME_KEYS.agent) : who.label,
      detail: who.agentId ?? who.label,
      kind,
      self: false,
    };
  }
  return { name: tr(AUTHOR_NAME_KEYS[kind]), detail: kind, kind, self: false };
}
