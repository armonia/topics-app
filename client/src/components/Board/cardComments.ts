/**
 * Which comments a review card shows: the human request, then the answer.
 *
 * The card used to lead with the LAST non-status comment, whoever wrote it.
 * Commenting a card in review REJECTS it and wakes the agent up again, so a
 * human comment in the thread is almost always a rework request. By the time
 * the task is back in review the last word is the agent's again: the reviewer
 * read the answer with his own request already off the card, and had to
 * remember what he had asked.
 *
 * So the card carries the PAIR when there is one: the human request on top,
 * compressed to one line as context, and the thread's last word below, still
 * the protagonist. When nobody typed anything the card is exactly what it was:
 * no row is reserved and then left blank.
 *
 * The choice lives here, outside the component, because it is the part that can
 * be wrong in silence: any pair renders as a perfectly plausible card.
 */

import { HUMAN_AUTHOR, isMachineNote, isThreadSpeech } from '../../../../shared/board';
import { isResolvedParkedQuestion, isSettledParkedQuestion } from '../../../../shared/parked-question';
import type { BoardTask, CardComment } from '../../lib/board';

export interface CardComments<T extends CardComment = CardComment> {
  /**
   * The thread's last word. The card leads with it, as it always did.
   *
   * Usually the agent. It can also be machine evidence (a `review-note` with
   * the live-preview URL lands exactly when the task enters review), which is
   * why `humanContext` is gated on a real reply existing rather than on this
   * field alone.
   */
  latest: T;
  /** The human request `latest` follows, or null when there is none to quote. */
  humanContext: T | null;
}

/**
 * A comment a PERSON typed on the board.
 *
 * Three conditions, and the third is the one that bites. `author: 'user'` is
 * also the signature the server puts on its own narration when a person pulled
 * the lever: Stop and "archive with a live agent" both go through
 * `release({ by: 'user' })`, which writes the reason into the thread as a plain
 * comment. Without `isMachineNote` the card hands "Fermato da te: agent
 * interrotto." back to you as your own request, on a task where you never typed
 * a word.
 */
export function isHumanComment(comment: CardComment): boolean {
  return comment.author === HUMAN_AUTHOR
    && comment.kind === 'comment'
    && !isMachineNote(comment.content);
}

/**
 * A human comment worth quoting above the answer.
 *
 * Same as `isHumanComment` plus text: an attachment-only comment has nothing to
 * put on that line, and the card must never open a row it then leaves blank.
 */
function isHumanRequest(comment: CardComment): boolean {
  return isHumanComment(comment) && comment.content.trim() !== '';
}

/**
 * Something ANSWERED the request: speech from someone other than the human.
 *
 * `kind` matters. A `review-note` is evidence the machine attached to the
 * delivery, not a reply, and a thread whose only entry after the request is a
 * preview screenshot has nothing that reads as an answer. Quoting the request
 * above it would promise a pair the card cannot deliver.
 */
function isReply(comment: CardComment): boolean {
  return comment.kind === 'comment' && comment.author !== HUMAN_AUTHOR;
}

/**
 * Pick the card's comments, or null when the thread has nothing to say.
 *
 * `kind: 'status'` rows are transition history written on every status change,
 * and `kind: 'service'` rows are the dispatcher's bookkeeping: neither is
 * anybody's word, so both are dropped before anything is decided
 * (`isThreadSpeech`, the same predicate the quick-reply buttons use). Without
 * the second one a queue hold or a restart note written after the agent's answer
 * became the card's `latest`: the card printed "In attesa di uno slot" as the
 * delivery while the buttons underneath still offered the agent's question.
 */
/**
 * Una riga che fa da CONTORNO alla consegna, non da parola.
 *
 * Due specie, e la seconda l'avevo mancata stamattina:
 *
 *  · `review-note` — l'evidenza che la macchina attacca entrando in review
 *    («Consegna SENZA anteprima…», «Anteprima viva pronta — http://…»);
 *  · le NOTIFICHE DI STATO del sistema — `author: 'system'` con `kind:
 *    'comment'`, che nel db sono 3984, la specie piu' numerosa: «l'agent ha
 *    lavorato 2 turni ma non ha spostato il task», «Worktree e branch
 *    ripuliti», «Niente da atterrare».
 *
 * Le due hanno lo stesso difetto: il sistema scrive per ULTIMO, quindi
 * arrivano sempre dopo il riassunto e gli rubano il posto in cima alla card.
 * Misurato sulla board vera il 17/08: un riassunto da 1832 caratteri arrivava
 * tagliato a 201 perche' il taglio pieno se lo prendeva la notifica.
 *
 * MA UNA DOMANDA DEL SISTEMA NON E' CONTORNO. Il sistema chiede davvero, con i
 * bottoni di risposta rapida (```question), e quella e' l'unica cosa che tiene
 * ferma la card: nasconderla sarebbe peggio del difetto che sto togliendo.
 */
function contorno(c: CardComment): boolean {
  if (c.kind === 'review-note') return true;
  if (c.author !== 'system') return false;
  // Il recinto ```question e' la firma di una domanda vera: se c'e', resta.
  return !c.content.includes('```question');
}

/**
 * UNA DOMANDA GIA' RISOLTA NON E' PIU' UNA DOMANDA, quindi non e' piu' nemmeno
 * l'eccezione che la tiene in cima alla card.
 *
 * `contorno` lascia passare ogni `system` che contenga un recinto ```question,
 * ed e' giusto: quella e' l'unica cosa che tiene ferma la card. Ma quando i
 * sottotask hanno risposto muovendosi, `Card.tsx` smette di parsarla (vedi
 * `isSettledParkedQuestion`) e quel commento cade nel ramo «testo semplice»:
 * la card stampa il MARKDOWN GREZZO della domanda morta — recinto, elenco
 * puntato delle due opzioni e tutto — al posto del riassunto della consegna.
 * Misurato il 17/08 su `63bcc31b` (remotion-scenes): 3 sottotask su 3 chiusi,
 * e la card mostrava ancora «Fermo su 2 sottotask che non lavorera nessuno»
 * con sotto «- Rimetti in coda i sottotask / - Archivia i sottotask» come
 * testo inerte, senza bottoni.
 *
 * Quindi l'eccezione va CHIUSA alle stesse condizioni in cui i bottoni
 * spariscono: una domanda a cui nessuno puo' piu' rispondere torna a essere
 * contorno come ogni altra nota di sistema. Resta nel thread, smette di
 * prendere il posto della parola vera.
 *
 * L'asimmetria e' la stessa di `shared/parked-question.ts` e va nello stesso
 * verso: senza i figli (`counts` assenti) non si spegne niente. Meglio una
 * domanda morta in cima che una viva nascosta.
 */
function domandaSpenta(c: CardComment, counts: CardThreadContext | null): boolean {
  if (!counts) return false;
  return counts.children
    ? isResolvedParkedQuestion(c, counts.children)
    : isSettledParkedQuestion(c, counts);
}

/**
 * Quello che la RIGA sa e il thread da solo non puo' sapere.
 *
 * Due fatti, entrambi opzionali perche' senza di loro il selettore si comporta
 * come prima (nessuna promozione, nessuna domanda spenta): il verso sicuro.
 *
 *  · i sottotask, per sapere se la domanda sui figli fermi e' ancora viva — la
 *    card ha due numeri, il drawer ha i figli veri, e quando ci sono i figli
 *    vince il predicato esatto;
 *  · CHI HA CONSEGNATO, che e' l'unica cosa capace di distinguere due thread
 *    identici: un commento firmato `user` puo' essere una consegna fatta a mano
 *    (chi lavora dal terminale chiude cosi') oppure una richiesta a cui nessuno
 *    ha mai risposto. Sullo schermo sono la stessa riga; nel database no.
 */
export interface CardThreadContext {
  subtaskCount?: number;
  subtaskDoneCount?: number;
  children?: readonly { status: string; archived?: number | boolean }[];
  /** `'system'` = nessuno ha consegnato: ce l'ha portata il dispatcher. */
  deliveredBy?: string | null;
}

export function selectCardComments<T extends CardComment>(
  comments: readonly T[],
  ctx?: CardThreadContext | null,
): CardComments<T> | null {
  const speech = comments.filter(isThreadSpeech);
  // LA NOTA DEL SISTEMA NON E' LA PAROLA DELLA CONSEGNA.
  //
  // Una `review-note` la scrive la macchina a OGNI ingresso in review
  // («Consegna SENZA anteprima…», «Anteprima viva pronta — http://localhost:
  // 3400/»), quindi arriva sempre DOPO il riassunto di chi ha consegnato e ne
  // prendeva il posto in cima alla card. Misurato il 17/08: 19 card su 22
  // mostravano un promemoria di sistema al posto di cio' che c'era da
  // rivedere. Segnalato: «gli ultimi commenti che devo da review non hanno
  // senso, saranno messaggi di sistema».
  //
  // Non si buttano: se sono l'UNICA voce dicono comunque qualcosa (perche' la
  // card e' cieca). Si tolgono solo di mezzo quando c'e' una parola vera.
  const parole = speech.filter((c) => !contorno(c) && !domandaSpenta(c, ctx ?? null));
  const vive = parole.length ? parole : speech;
  const latest = vive[vive.length - 1];
  if (!latest) return null;
  // ── QUANDO NESSUNO HA RISPOSTO, LA NOTA DI SISTEMA E' LA PAROLA NUOVA ──────
  //
  // `contorno` toglie di mezzo le note di sistema perche' il sistema scrive per
  // ULTIMO e rubava il posto al riassunto della consegna. Quel motivo esiste
  // solo se una consegna c'e'. Quando l'agent non ha prodotto niente — turni
  // bruciati da errori del provider, `delivered_by = 'system'` — l'ultima
  // parola rimasta e' la RICHIESTA UMANA, e la card la ristampa in cima come se
  // fosse la novita'.
  //
  // Non e' un dettaglio estetico, e' un fraintendimento misurato. Su `5cf58e29`
  // (17/08) la card apriva con la mia frase di un'ora prima — «Messa in
  // progress = via libera» — senza nessun segno di chi l'avesse scritta: letta
  // in cima a una card in review sembra un'ISTRUZIONE del sistema («per farlo
  // andare avanti devi rimetterlo in progress»), mentre l'unica riga che
  // spiegava davvero perche' la card fosse li' («l'agent ha lavorato 2 turni ma
  // non ha spostato il task in review da solo… rimandalo indietro») era stata
  // scartata come contorno.
  //
  // Quindi la nota di sistema cede il posto a CHI HA CONSEGNATO, non al
  // silenzio: se davanti a se' non trova altro che la richiesta umana, torna lei
  // la parola — e la richiesta le fa da contesto sopra, che e' esattamente la
  // coppia che questo modulo esiste per comporre.
  //
  // IL CANCELLO E' `deliveredBy`, e non poteva essere il thread. Un commento
  // firmato `user` come ultima parola ha due significati opposti che sullo
  // schermo sono identici: la CONSEGNA fatta a mano (chi lavora dal terminale
  // chiude scrivendo cos'ha fatto — e li' la notifica del sistema arriva dopo e
  // le ruberebbe il posto, che e' il difetto tolto stamattina), oppure una
  // richiesta a cui nessuno ha mai risposto. La riga lo sa: `delivered_by =
  // 'system'` dice che quella parola NON e' una consegna, perche' consegne non
  // ce ne sono state. Senza il campo non si promuove niente.
  if (isHumanComment(latest)) {
    if (ctx?.deliveredBy === 'system') {
      const idx = speech.lastIndexOf(latest);
      // Solo una nota che SPIEGA, e cioe' `kind: 'comment'` — la specie con cui
      // il dispatcher scrive perche' la card e' finita in review. Una
      // `review-note` no: e' l'evidenza attaccata alla consegna («Anteprima viva
      // pronta — http://…»), e una card la cui unica novita' e' uno screenshot
      // non ha ancora ricevuto risposta. Promuoverla direbbe che qualcuno ha
      // risposto quando nessuno l'ha fatto.
      const nota = speech.slice(idx + 1).filter((c) => c.author === 'system' && c.kind === 'comment').pop();
      if (nota) return { latest: nota, humanContext: latest };
    }
    // Ha parlato lui per ultimo davvero (o non c'e' niente da promuovere): e' il
    // protagonista, e citarlo sopra se stesso stamperebbe due volte la stessa
    // riga. Il `return` e' qui e non piu' in basso apposta: senza, la scansione
    // all'indietro troverebbe la richiesta PRECEDENTE e la card stamperebbe
    // sopra la frase che questa ha appena sostituito.
    return { latest, humanContext: null };
  }
  let requestAt = -1;
  for (let i = speech.length - 2; i >= 0; i--) {
    if (isHumanRequest(speech[i]!)) { requestAt = i; break; }
  }
  if (requestAt < 0) return { latest, humanContext: null };
  const answered = speech.slice(requestAt + 1).some(isReply);
  return { latest, humanContext: answered ? speech[requestAt]! : null };
}

/** I campi della riga su cui si decide cosa la card mostra e cosa deve chiedere. */
export type CardThreadRow = Pick<BoardTask, 'status' | 'assignedTopicId' | 'deliveredBy' | 'deliveredReason' | 'subtaskCount' | 'subtaskDoneCount' | 'recentComments'>;

/**
 * La card ha una PAROLA da mostrare: l'ultima del thread, con i suoi bottoni.
 *
 * Due sorgenti, un solo ramo: l'agente che ha consegnato, e il SISTEMA quando
 * lo stallo dei figli parcheggiati fa la domanda al posto suo (lì la card può
 * non avere nessun topic legato). Fuori dalla review nessuna delle due esiste,
 * ed è per questo che il server attacca `recentComments` solo a quella colonna.
 */
export function showsCardThread(task: CardThreadRow): boolean {
  if (task.status !== 'review') return false;
  // SE IL SERVER LI HA GIA' MANDATI, L'UNICA DOMANDA E' «c'e' qualcosa da
  // leggere?». Prima si pretendeva una sessione agente, e per le card senza
  // — chi lavora dal terminale, chi consegna a mano, chi porta in review
  // scrivendo cos'ha fatto — il thread arrivava fino al browser e finiva in
  // nessun pixel. Misurato sulla board vera il 17/08: 22 card in review, 22
  // con `recentComments` nella risposta, ZERO che li disegnavano. Segnalato
  // due volte: «sembrano solo i task spostati, ma una volta in review dovrei
  // vedere aggiornamenti, no?».
  //
  // `[]` (nessun commento) resta un no: un riquadro vuoto e' peggio del
  // silenzio.
  if (task.recentComments?.length) return true;
  // Il server NON li ha ancora mandati (`undefined` = non lo so ancora): allora
  // vale la vecchia domanda, perche' qui si sta decidendo se CHIEDERLI, e
  // chiederli per ogni card senza thread sarebbe una richiesta a vuoto.
  return task.recentComments === undefined
    && (!!task.assignedTopicId || task.deliveredReason === 'parked_children');
}

/**
 * COSA MANCA ALLA CARD dopo quello che la lista le ha già dato — cioè se deve
 * aprire un `GET /api/tasks/:id` per conto suo.
 *
 * Era una richiesta PER CARD, e il dettaglio non è una riga: si porta dietro
 * l'intero thread del task. Aprendo la board, ogni scheda in review ne
 * sparava una. Adesso i commenti viaggiano con la lista, e resta un solo
 * motivo per chiedere: i sottotask, che nel feed non ci sono
 * (`rootsOnly`) e che la card in review espande come checklist della consegna.
 *
 * `'thread'` è la ricaduta per un server più vecchio del client (il guscio
 * Tauri incorpora il suo `public/` e può restare indietro): senza il campo
 * nuovo la card torna a chiedere, invece di restare muta.
 *
 * La decisione sta QUI e non dentro il componente perché è ciò che il test può
 * eseguire: montare la card vorrebbe dire montare mezza board.
 */
export function cardDetailNeed(task: CardThreadRow): 'none' | 'children' | 'thread' {
  if (showsCardThread(task) && task.recentComments === undefined) return 'thread';
  if (task.status === 'review' && task.subtaskCount > 0) return 'children';
  return 'none';
}

/** I commenti che la card disegna, presi dalla riga della lista. `null` quando
 *  non c'è niente da mostrare o quando il server non li manda. */
export function cardCommentsFromRow(task: CardThreadRow): CardComments | null {
  if (!showsCardThread(task) || !task.recentComments) return null;
  // I due numeri che la riga porta sempre: bastano a riconoscere una domanda
  // sui sottotask a cui i sottotask hanno gia' risposto. Il predicato e' quello
  // stretto (`isSettledParkedQuestion`) — puo' lasciare viva una domanda morta,
  // mai spegnerne una viva.
  return selectCardComments(task.recentComments, {
    subtaskCount: task.subtaskCount,
    subtaskDoneCount: task.subtaskDoneCount,
    deliveredBy: task.deliveredBy,
  });
}
