/**
 * UNA DOMANDA NON E' CODICE, e la card la stampava come tale.
 *
 * Il sistema e l'agent scrivono le domande dentro un recinto ```question, con
 * le opzioni come elenco puntato: e' un formato di TRASPORTO, letto da
 * `parseQuestionBlock` per disegnare i bottoni di risposta rapida. Nessuna
 * superficie dovrebbe mai mostrarlo com'e'.
 *
 * Ma le superfici hanno due rami, e solo uno di quei due parsava. Quando il
 * blocco non e' piu' «la domanda in fondo al thread» — perche' i sottotask
 * hanno gia' risposto muovendosi, oppure perche' e' arrivato un commento dopo —
 * il testo cade nel ramo «parola qualunque» e finisce dritto nel renderer
 * markdown. Li' ```…``` significa BLOCCO DI CODICE: `COMPACT_MD_CLS` lo
 * disegna con `[&_pre]:overflow-x-auto` e `whitespace-pre`, quindi una frase
 * italiana di 300 caratteri diventa una riga sola che si legge SCORRENDO DI
 * LATO dentro una colonna larga un terzo di schermo.
 *
 * Segnalato guardando la board: «vedo lo scroll orizzontale invece di vedere in
 * verticale e non capisco il senso».
 *
 * La cura sta qui, in un modulo puro e condiviso, e non dentro il JSX di una
 * card: il difetto e' esattamente il genere di cosa che si aggiusta su una
 * superficie e resta rotta sulle altre due. Il recinto si scioglie in prosa —
 * la domanda come paragrafo, le opzioni come elenco markdown vero, che va a
 * capo da solo. Nessun testo si perde: cambia solo che si legge.
 */

import { parseQuestionBlock } from './board';

/**
 * Il testo di un commento pronto per un renderer markdown: senza recinti
 * ```question, e quindi senza blocchi di codice che scorrono in orizzontale.
 *
 * Torna la stringa IDENTICA quando non c'e' niente da sciogliere — nessuna
 * allocazione e nessun rischio su tutti gli altri commenti, che sono la
 * stragrande maggioranza.
 *
 * Il testo attorno al recinto resta al suo posto, prima e dopo: un agente che
 * scrive due righe di contesto e poi chiede non deve vederle sparire.
 */
export function questionToProse(content: string): string {
  if (!content.includes('```question')) return content;
  const q = parseQuestionBlock(content);
  // Un recinto che non parsa (aperto e mai chiuso, corpo vuoto) NON si tocca:
  // meglio un blocco brutto che una frase mangiata da una regex.
  if (!q) return content;
  const opzioni = q.options.map((o) => `- ${o}`).join('\n');
  const prosa = opzioni ? `${q.question}\n\n${opzioni}` : q.question;
  return content.replace(/```question[\s\S]*?```/, prosa).trim();
}
