/**
 * «Fermo su N sottotask» è una DOMANDA CON UNA SCADENZA, e non ce l'aveva.
 *
 * Quando i figli di una card si fermano in `backlog`/`todo` e nessun turno li
 * muoverà, il server porta la card in review e scrive nel thread un blocco
 * `question` con due uscite (rimetti in coda / archivia). È giusto: senza, la
 * card resta ferma per sempre e nessuno se ne accorge.
 *
 * Quello che manca è l'altra metà. La domanda è un MESSAGGIO, e un messaggio non
 * invecchia: quando i sottotask poi si chiudono — perché l'agente li ha fatti nel
 * turno dopo, perché qualcuno li ha spostati a mano — il blocco resta lì, con la
 * sua cornice rossa e i suoi due bottoni, a chiedere una decisione che non esiste
 * più. Misurato il 16/08 sulla board viva: su 7 card in review, 3 mostravano una
 * domanda i cui sottotask erano già tutti `done`. Su una di quelle la domanda era
 * anche l'ULTIMA parola del thread, quindi la scheda offriva due risposte rapide
 * che non rispondevano a niente.
 *
 * È lo stesso difetto — e la stessa cura — di `shared/preview-retirement.ts`:
 * uno stato scritto come messaggio. Lì il fatto è passato su una colonna della
 * card; qui non serve nemmeno una colonna, perché il fatto È già leggibile dai
 * figli. Non si cancella niente dal database: la storia resta, e resta anche
 * sullo schermo — smette solo di presentarsi come una decisione da prendere.
 */

/** La firma testuale delle due varianti che il server scrive (`askParkedChildren`).
 *
 *  Ancorata all'inizio della riga dopo l'apertura del blocco: un commento umano
 *  che CITA la domanda se la porta dentro la frase, non in testa. Riconoscere il
 *  TESTO e non il `kind` è deliberato — le righe già scritte sul disco sono
 *  `comment` come tutte le altre, e nessuna migrazione le andrà a marcare. */
const PARKED_QUESTION_PATTERNS: RegExp[] = [
  /^Fermo su \d+ sottotask\b/m,
  /^Fermo di nuovo sugli stessi \d+ sottotask\b/m,
];

/** Il commento è la domanda di sistema sui sottotask fermi. */
export function isParkedChildrenQuestion(c: { content: string; author?: string | null }): boolean {
  // Solo `system`: la domanda la scrive il server, e un agente che ripetesse la
  // frase non deve poter far sparire la propria richiesta.
  if ((c.author ?? '').trim().toLowerCase() !== 'system') return false;
  const inner = c.content.replace(/^```question\s*/i, '').trimStart();
  return PARKED_QUESTION_PATTERNS.some((re) => re.test(inner));
}

/** Lo stato di un figlio, per quel poco che serve a questa decisione. */
export interface ParkedChildLike { status: string; archived?: number | boolean }

/**
 * Un figlio è FERMO nel senso della domanda: vivo, e in una colonna che nessun
 * turno verrà a prendere.
 *
 * Le due colonne sono quelle di `parkedChildren` in `server/services/tasks.ts`,
 * e devono restare quelle: se lì si allarga il predicato e qui no, una domanda
 * viva si spegne da sola — che è il verso in cui questo modulo non deve
 * sbagliare mai.
 */
export function isParkedChild(c: ParkedChildLike): boolean {
  if (c.archived === 1 || c.archived === true) return false;
  return c.status === 'backlog' || c.status === 'todo';
}

/**
 * La domanda è RISOLTA: chiedeva dei sottotask fermi, e adesso non ce n'è più
 * nessuno.
 *
 * Il verso non è ambiguo. La domanda si scrive solo quando almeno un figlio è
 * fermo, quindi «nessun figlio fermo adesso» vuol dire per forza che qualcosa è
 * successo DOPO. Il caso che resta fuori — una card senza figli del tutto —
 * torna comunque `true`, ed è corretto: una domanda sui sottotask di una card
 * che non ne ha più non ha nessuno a cui riferirsi.
 */
export function isResolvedParkedQuestion(
  c: { content: string; author?: string | null },
  children: readonly ParkedChildLike[],
): boolean {
  return isParkedChildrenQuestion(c) && !children.some(isParkedChild);
}

/**
 * La stessa domanda, vista dalla CARD — che non ha i figli, solo due numeri.
 *
 * `subtaskCount`/`subtaskDoneCount` non sanno distinguere «fermo» da «in volo»:
 * un figlio in `in_progress` non e' done e non e' fermo. Quindi qui si usa il
 * predicato PIU' STRETTO — tutti chiusi — che e' un sottoinsieme di «nessuno
 * fermo».
 *
 * L'asimmetria e' voluta e va nel verso giusto: questa funzione puo' lasciare
 * viva una domanda gia' risolta (rumore, si vede, si corregge), MAI spegnerne
 * una viva (una card che aspetta e non lo dice piu' a nessuno). Il drawer, che i
 * figli ce li ha, usa `isResolvedParkedQuestion` ed e' esatto.
 */
export function isSettledParkedQuestion(
  c: { content: string; author?: string | null },
  counts: { subtaskCount?: number; subtaskDoneCount?: number },
): boolean {
  if (!isParkedChildrenQuestion(c)) return false;
  const total = counts.subtaskCount ?? 0;
  const done = counts.subtaskDoneCount ?? 0;
  return total === 0 || done >= total;
}
