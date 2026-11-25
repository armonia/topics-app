import { TaskStatus, isAgentWorking } from './board-base';

// ─────────────────────────────────────────────────────────────────────────────
// Machine notes stamped with the HUMAN's signature.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The author every comment posted through the human board surface carries.
 *
 * It is also the signature `release()` puts on its own narration when a PERSON
 * pulled the lever: the status trail must say the human moved the card, and
 * `by` drives both the trail and the note. So `author === HUMAN_AUTHOR` alone
 * does not mean "a person typed this".
 */
export const HUMAN_AUTHOR = 'user';

/** Stop button: the machine narrates the cut turn under the human's name. */
export const NOTE_STOPPED_BY_HUMAN =
  'Fermato da te: agent interrotto. Rimetti il task in Todo per ripartire.';

/**
 * Lo stesso bottone su una card che era solo IN CODA. «Ferma» accetta anche
 * `queued`, e li' non c'e' nessun turno da tagliare: raccontare «agent
 * interrotto» a chi ha fermato una card mai partita descrive un fatto che non
 * e' successo, e lascia credere che del lavoro sia andato perso.
 */
export const NOTE_UNQUEUED_BY_HUMAN =
  'Tolto dalla coda da te: nessun agent era ancora partito. Rimetti il task in Todo per ripartire.';

/** Archiving a task with a live agent: same shape, same signature. */
export const NOTE_ARCHIVED_BY_HUMAN =
  'Archiviato da te mentre l\'agent lavorava: turno interrotto.';

/**
 * The tails that say WHICH option was picked. They are constants because a
 * reader has to recognise the fact in SQL, and a copy typed on the reading side
 * is a copy that stops matching the day the sentence is reworded.
 */
const PARKED_REQUEUED_TAIL = 'sottotask rimessi in coda.';
const PARKED_ARCHIVED_TAIL = 'sottotask archiviati.';
const PARKED_PROMOTED_TAIL = 'sottotask promossi a task indipendenti.';

/** The note `resolveParkedChildren` writes after the human picked an option. */
export function noteParkedChildrenResolved(decision: ParkedChildrenDecision, count: number): string {
  if (decision === 'requeue') {
    return `Sbloccato: ${count} ${PARKED_REQUEUED_TAIL} Torno in coda anch'io e riparto quando hanno finito.`;
  }
  if (decision === 'promote') {
    return `Sbloccato: ${count} ${PARKED_PROMOTED_TAIL} Li serve la coda, non io: torno in coda anch'io.`;
  }
  return `Sbloccato: ${count} ${PARKED_ARCHIVED_TAIL} Torno in coda: non c'è più niente ad aspettarmi.`;
}

/** The three ways out of the parked-subtask stall, named once for both sides. */
export type ParkedChildrenDecision = 'requeue' | 'archive' | 'promote';

/**
 * «RIMETTI IN CODA È GIÀ STATO FATTO SU QUESTA CARD», per chi lo conta in SQL.
 *
 * The escape hatch out of the parked-subtask loop hangs on this question, and
 * it was dead: the probe compared a comment to the BUTTON LABEL
 * (`content = REQUEUE_PARKED_LABEL`), and nothing ever writes a comment whose
 * whole body is that label. So the count was always zero, the third option
 * (`TAKE_OVER_PARKED_LABEL`) was never offered, and the human was handed the
 * same circular button forever — which is the exact loop that option exists to
 * break.
 *
 * The fact that DOES get written is the note above, so that is what gets
 * counted. Exported as a LIKE pattern built from the same constant the writer
 * uses: one declaration, two sides, no way to drift.
 */
export const PARKED_REQUEUE_NOTE_LIKE = `%${PARKED_REQUEUED_TAIL}%`;

/** The shape of `noteParkedChildrenResolved`, matched without rebuilding it. */
const PARKED_CHILDREN_NOTE = /^Sbloccato: \d+ sottotask (?:rimessi in coda|archiviati|promossi a task indipendenti)\./;

/**
 * Il prefisso con cui un turno finito male si annuncia dentro `content`.
 *
 * VIVE QUI perché lo leggono DUE alberi. Il client lo usa per accendere il
 * banner e il bottone «Riprova» (`turnError.ts`); il server per NON scambiare
 * un cartello per le parole dell'agente quando rispecchia la sua ultima prosa
 * sulla card (`getLastAgentText`). Ricopiarne il carattere a mano nel secondo
 * era la duplicazione che diverge al primo cambio — la stessa critica che
 * `isMachineVoice` muove agli elenchi di stringhe tenuti allineati a mano.
 *
 * È marcato LEGACY perché il verdetto autorevole, per il client che sa
 * leggerli, è il blocco `error`. Ma non è morto: il server scrive SEMPRE anche
 * il testo quando la riga sarebbe altrimenti vuota (`routes/chat.ts`, i due
 * rami che assegnano `fullContent`), e per una ragione dichiarata lì — è
 * l'unica colonna che la ricerca ⌘K interroga, e i client vecchi leggono da
 * lì. Misurato sul DB il 20/08: 573 righe col prefisso, ZERO con blocco
 * `error` e `content` vuoto.
 */
export const TURN_ERROR_PREFIX = '\u26a0\ufe0f';

/**
 * Prose the SERVER wrote, even though the comment is signed `user`.
 *
 * The board reads `author: 'user'` as "a person typed this" in the one place
 * where it matters: a card back in review quotes the last human request above
 * the answer, because commenting a card in review rejects it and wakes the
 * agent, so that request is what the delivery below is answering. A stop or an
 * archive is not a request. Left in, the card hands you back "Fermato da te:
 * agent interrotto." as your own words on the very next delivery.
 *
 * The sentences live here, next to the only functions that write them, so the
 * reader and the writers cannot drift apart: change the copy on one side and
 * the other side follows, because there is only one side.
 */
export function isMachineNote(content: string): boolean {
  const text = content.trim();
  return text === NOTE_STOPPED_BY_HUMAN
    || text === NOTE_UNQUEUED_BY_HUMAN
    || text === NOTE_ARCHIVED_BY_HUMAN
    || PARKED_CHILDREN_NOTE.test(text);
}

/**
 * Quante attese di FILA per la stessa ragione, prima che decida un umano.
 *
 * Sei e non due, che è il tetto dei tentativi di dispatch: quel numero frena i
 * turni MORTI, e per quelli due è generoso. Un'attesa non è un turno morto, e
 * col default di 15 minuti sei attese sono un'ora e mezza di condizione che non
 * arriva. Sotto quella soglia fermare il task vorrebbe dire chiedere all'umano
 * di guardare una cosa che stava per sistemarsi da sola.
 */
export const WAIT_STREAK_CAP = 6;

/**
 * Il tetto sull'ALTRA grandezza: quanto è lunga la serie in orologio.
 *
 * Serve perché `minutes` lo sceglie l'agent e arriva a 1440: due attese da
 * dodici ore non sfondano mai il tetto sul conteggio, ma sono un giorno in cui
 * nessuno ha guardato la card. Si misura dall'inizio della serie a ORA, non
 * sommando le finestre chieste: la finestra è una promessa, il tempo passato è
 * un fatto.
 */
export const WAIT_SERIES_MAX_MS = 4 * 60 * 60 * 1000;

/**
 * La ragione ridotta alla sua identità: è questo che decide se un'attesa
 * CONTINUA la serie o ne apre una nuova.
 *
 * Minuscole e spazi compattati perché la stessa attesa, ridichiarata da un turno
 * nuovo che non ha in mano il testo esatto di prima, si riscrive a mano quasi
 * uguale. «Aspetto che CI finisca» e «aspetto che ci finisca  » sono la stessa
 * condizione, e contarle come due serie diverse azzererebbe il contatore a ogni
 * giro. Cioè lo renderebbe un contatore che non conta niente.
 */
export function waitReasonKey(reason: string): string {
  return reason.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocco `question` — il formato, dichiarato dove SCRITTURA e LETTURA lo vedono
// entrambe (`addComment` lo compone, `parseQuestionBlock` lo legge).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IL BLOCCO ```question È UN CONTRATTO, non una formattazione.
 *
 * Lo compone il server (unico scrittore, `addComment`) in una forma fissa —
 * fence, la domanda su UNA riga, poi le opzioni come righe `- …` — e lo legge
 * `parseQuestionBlock` per disegnare le risposte rapide. Cambiare quel layout
 * non è un dettaglio estetico: è una card che perde i bottoni, e le risposte
 * rapide devono esserci SEMPRE finché il task non è chiuso.
 *
 * Da qui la conseguenza che vale la pena scrivere: dentro la fence il corpo
 * resta appiattito, perché una riga `- …` del corpo non sarebbe distinguibile
 * da un'opzione. Un testo lungo che vuole tenersi l'impaginazione (un piano)
 * viaggia FUORI dalla fence, nello stesso commento: il parser lascia intatto
 * ciò che sta attorno al blocco, e le tre superfici (thread, card, tab Piano)
 * lo rendono come markdown. Il posto dove separare corpo e opzioni è il
 * RENDER, non il testo salvato — questo modulo dichiara solo la forma.
 */

/** Etichette senza punteggiatura/emoji/spaziatura: due opzioni si confrontano
 *  per SIGNIFICATO, non per byte (il modello aggiunge volentieri un ✅). */
export function normalizeActionLabel(s: string): string {
  return s.replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Le due opzioni del protocollo piano-prima. Sono un CONTRATTO, non un testo di
 * cortesia: il dispatcher le scrive nell'envelope, e la loro presenza è ciò che
 * dice al servizio «questo commento È il piano» (→ `tasks.plan_comment_id`).
 * Prima il piano si indovinava — «l'ultimo commento non-utente» — e su 13 task
 * piano-prima l'euristica sbagliava 13 volte su 13: il commento di rettifica,
 * o la consegna con «Landa su main», rubavano il posto al piano.
 */
export const PLAN_APPROVE_LABEL = 'Approva il piano';
export const PLAN_REVISE_LABEL = 'Da rivedere';

/** Vero quando fra le opzioni c'è l'approvazione di un piano (match tollerante). */
export function hasPlanApproveOption(options: readonly string[]): boolean {
  const want = normalizeActionLabel(PLAN_APPROVE_LABEL);
  return options.some((o) => normalizeActionLabel(o) === want);
}

/**
 * THE RESERVED QUICK-REPLY LABELS — the ones the BOARD executes by itself.
 *
 * They live in `shared/` and not in the task service because FIVE surfaces have
 * to agree on them, and three of them are in the client: the dispatch chip and
 * the two review gates (server), the push notification (server), the in-app
 * banner (client) and the quick-reply de-duplicator (client). The notification
 * pair was left reading a different rule and kept announcing finished work as a
 * question — one vocabulary, or the split comes back.
 *
 * They are deliberately NOT translated. The option text travels to the server
 * and is matched BY VALUE, so the de-duplicator has to compare against this
 * constant and not against the button's translation: under locale `en` the
 * button reads "Land on main" while the option still says "Landa su main", and
 * comparing the translation let the rejecting twin back in.
 */
export const LAND_ACTION_LABEL = 'Landa su main';
export const PUBLISH_ACTION_LABEL = 'Landa e pubblica';
export const REQUEUE_PARKED_LABEL = 'Rimetti in coda i sottotask';
export const ARCHIVE_PARKED_LABEL = 'Archivia i sottotask';
/**
 * La terza uscita, e nasce da un ANELLO misurato: «rimetti in coda» porta i
 * figli in `todo`, ma un figlio in `todo` conta fermo lo stesso (il tick lista
 * `rootsOnly`), quindi la domanda tornava identica al turno dopo e chi
 * rispondeva ripremeva lo stesso bottone. Alla seconda volta la board smette di
 * offrire quella strada e offre QUESTA: la card torna in mano a una persona,
 * che e' l'unica cosa che la sblocca davvero quando l'agente non tocca i suoi
 * step.
 */
export const TAKE_OVER_PARKED_LABEL = 'La prendo in mano io';
/**
 * LA QUARTA ETICHETTA, ed e' quella che l'envelope raccomanda gia' all'agente.
 *
 * Le due storiche rispondono male al caso piu' frequente. La misura: delle card
 * ferme sui propri step il 19/08 4 su 4 e il 18/08 15 su 16 portavano nel thread
 * una traccia di INTERRUZIONE (riavvio, sessione morta, ripresa). Quegli step non
 * sono disobbedienza: sono lavoro vero rimasto senza turno. Rimetterli in coda
 * non li muove (nessun dispatcher prende un figlio), archiviarli butta la lista
 * di cio' che restava da fare.
 *
 * Togliere il `parent_task_id` e' l'unico gesto che li rende servibili: e' cio'
 * che `buildKickoff` ordina all'agente («o lo fai, o lo PROMUOVI a task
 * indipendente»), e finora la board non lo offriva a chi rivede.
 */
export const PROMOTE_PARKED_LABEL = 'Promuovi i sottotask a task';

/** Tolerant match (ignores emoji/punctuation/spacing the model may add). */
export function isLandActionLabel(text: string | undefined | null): boolean {
  return !!text && normalizeActionLabel(text) === normalizeActionLabel(LAND_ACTION_LABEL);
}
export function isPublishActionLabel(text: string | undefined | null): boolean {
  return !!text && normalizeActionLabel(text) === normalizeActionLabel(PUBLISH_ACTION_LABEL);
}
export function isRequeueParkedLabel(text: string | undefined | null): boolean {
  return !!text && normalizeActionLabel(text) === normalizeActionLabel(REQUEUE_PARKED_LABEL);
}
export function isArchiveParkedLabel(text: string | undefined | null): boolean {
  return !!text && normalizeActionLabel(text) === normalizeActionLabel(ARCHIVE_PARKED_LABEL);
}
export function isTakeOverParkedLabel(text: string | undefined | null): boolean {
  return !!text && normalizeActionLabel(text) === normalizeActionLabel(TAKE_OVER_PARKED_LABEL);
}
export function isPromoteParkedLabel(text: string | undefined | null): boolean {
  return !!text && normalizeActionLabel(text) === normalizeActionLabel(PROMOTE_PARKED_LABEL);
}

/**
 * A quick-reply label the BOARD executes by itself, as opposed to an answer
 * that steers the agent.
 *
 * These five are exactly the labels `POST …/tasks/:id/review` runs server-side
 * (publish, requeue/archive/promote parked children, land, take over): picking
 * one is an ORDER to the system, and nothing about the work is still undecided.
 * Every other option
 * (a plan's "Approva il piano", a free "Aspetta, ho un dubbio") resumes the
 * AGENT with the human's words, which is what "the card is waiting for a
 * person" means.
 */
export function isBoardActionLabel(text: string | undefined | null): boolean {
  return isLandActionLabel(text) || isPublishActionLabel(text)
    || isRequeueParkedLabel(text) || isArchiveParkedLabel(text) || isTakeOverParkedLabel(text)
    || isPromoteParkedLabel(text);
}

/**
 * L'antenato al lavoro che spiega un sottotask senza agente proprio: chi lo sta
 * lavorando, e con che titolo dirlo. Risolto dal server come `BlockerRef` e per
 * lo stesso motivo — la lista della board è un progetto solo, `rootsOnly`, non
 * archiviati, quindi il padre di un sottotask spesso NON è fra i task che il
 * client ha in mano, e cercarcelo dentro dava «nessuno lo lavora» proprio quando
 * qualcuno lo stava lavorando.
 */
export interface AncestorAtWork {
  id: string;
  text: string;
}

/**
 * Chi lavora un sottotask `in_progress` che non ha né topic né chip di dispatch.
 *
 * `parent-turn` = lo lavora un antenato dentro il PROPRIO turno: è il flusso
 * voluto — l'agente si crea la checklist come sottotask e la spunta mentre va —
 * ed è la norma schiacciante (misurato l'11/08/2026 sul DB vivo: 243 figli
 * chiusi in quella forma in un giorno, 281 il giorno prima).
 *
 * `unattended` = nessun antenato è al lavoro: la card è rimasta lì e non la
 * lavora nessuno. Rara (1 card viva su ~1.276 al momento della misura) ma reale,
 * e oggi invisibile: il recupero orfani filtra sul chip di dispatch, che qui non
 * c'è, quindi non vede né questo caso né l'altro.
 */
export type SubtaskWork =
  | { kind: 'parent-turn'; ancestor: AncestorAtWork }
  | { kind: 'unattended' };

/**
 * Un antenato sta lavorando ADESSO?
 *
 * `isAgentWorking` da solo non basta: `dispatch_state` resta scritto anche su
 * righe che nel frattempo sono state archiviate o mosse fuori da `in_progress`,
 * e leggerlo da solo farebbe passare per «al lavoro» un padre già chiuso.
 *
 * NON guarda `topics.archived`: i topic che il dispatcher crea per un agente
 * NASCONO archiviati (sono worker di sfondo, non tab da mostrare in sidebar).
 * Misurato l'11/08/2026: 755 topic archiviati su 767, e tutti e 7 i task con un
 * agente vivo in quel momento — compreso quello che stava girando — avevano il
 * topic `archived = 1`. Usare quel bit come segno di vita inverte la risposta
 * sul 100% dei casi sani.
 */
export function isAncestorAtWork(a: {
  status: TaskStatus | string;
  dispatchState: string | null | undefined;
  archived: boolean;
}): boolean {
  return !a.archived && a.status === 'in_progress' && isAgentWorking(a.dispatchState);
}

/**
 * La forma ambigua: un sottotask `in_progress` MAI dispacciato — niente topic,
 * niente chip. È l'unica in cui la domanda «chi lo lavora?» non ha già risposta
 * sulla card: con un topic c'è il deep-link, con un chip c'è lo stato.
 */
export function isUnattributedSubtask(t: {
  status: TaskStatus | string;
  parentTaskId: string | null | undefined;
  assignedTopicId: string | null | undefined;
  dispatchState: string | null | undefined;
}): boolean {
  return t.status === 'in_progress' && !!t.parentTaskId && !t.assignedTopicId && !t.dispatchState;
}

/**
 * Il segnale, DERIVATO dalla catena dei padri: nessuna migration e nessun
 * `assigned_topic_id` ereditato — quella colonna pesa su quota, dispatcher e
 * deep-link, e riempirla per dire una cosa che si può leggere sarebbe pagare
 * tre conti per un'etichetta.
 *
 * Nemmeno `created_by_topic_id` (migration 093) risponde: sembra la scorciatoia
 * — «chi mi ha creato è il topic che mi lavora» — ma è scritto solo su una
 * parte delle righe. Misurato l'11/08/2026 sui figli chiusi in giornata nella
 * forma ambigua: 90 su 249 ce l'hanno, 159 no. Leggerlo come segnale darebbe
 * «non la lavora nessuno» sui due terzi dei casi sani.
 *
 * `ancestors` arriva ordinata dal padre in su. Vince il PRIMO antenato al
 * lavoro, non il padre diretto: l'agente che lavora un task si crea la checklist
 * come figli, e quei figli possono avere figli loro — la catena misurata arriva
 * a due livelli, e chi tiene il turno può stare più in alto del padre.
 *
 * Torna `null` quando la domanda non si pone (non è un sottotask, non è in
 * corso, o ha già un agente suo): un `null` qui vuol dire «niente da dire»,
 * mai «non lo lavora nessuno» — quello è `unattended`, ed è un'altra cosa.
 */
export function deriveSubtaskWork(
  task: {
    status: TaskStatus | string;
    parentTaskId: string | null | undefined;
    assignedTopicId: string | null | undefined;
    dispatchState: string | null | undefined;
  },
  ancestors: ReadonlyArray<{
    id: string;
    text: string;
    status: TaskStatus | string;
    dispatchState: string | null | undefined;
    archived: boolean;
  }>,
): SubtaskWork | null {
  if (!isUnattributedSubtask(task)) return null;
  const at = ancestors.find(isAncestorAtWork);
  return at ? { kind: 'parent-turn', ancestor: { id: at.id, text: at.text } } : { kind: 'unattended' };
}

