import { TaskStatus, isAgentWorking } from './board-base';

import { BlockerRef, DispatchMemoryQueueReason } from './board-contract';

// ─────────────────────────────────────────────────────────────────────────────
// PERCHÉ questa card è ferma — la ragione, calcolata dove la si conosce.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I motivi per cui un task non si muove. Uno per ramo del dispatcher, più uno
 * (`checklist_frozen`) per la card che è già uscita dalla coda e si è fermata
 * dall'altra parte, in review, su una checklist che nessuno lavorerà.
 *
 * Esistono come UNIONE e non come booleani sparsi perché la card ne mostra uno
 * solo, e quale sia è una precedenza: un task senza board non parte nemmeno se
 * il suo bloccante chiude, e dirgli «aspetta una card» sarebbe una bugia con la
 * faccia sicura. L'ordine di `deriveQueueReason` è quello del dispatcher.
 */
export type QueueReasonKind =
  | 'slot'           // idoneo: aspetta solo il suo turno nella coda
  | 'blocked'        // `blocked_by_task_id` ancora aperto
  | 'deferred'       // `dispatch_deferred_until` nel futuro
  | 'attempts'       // `dispatch_attempts >= dispatchRetryCap`
  | 'dispatch_off'   // interruttore di dispatch spento
  | 'no_project'     // nessuna board con una directory: nessun cwd, nessun agente
  | 'parent_review'  // è uno step e il padre aspetta una decisione umana
  | 'parent_turn'    // è uno step e l'agente del padre lo lavora nel suo turno
  | 'parent_idle'    // è uno step e il padre non è al lavoro: non lo lavora nessuno
  | 'heavy_hold'     // è PESANTE, aspetta margine, e intanto tiene ferma la coda
  | 'heavy_busy'     // un ALTRO task pesante è al lavoro e si prende la macchina da solo
  | 'resource_floor' // the machine is under the RAM/disk floor: no agent is admitted at all
  | 'resource_pressure' // «per risorse»: the machine is over the chosen load/memory threshold
  | 'spend_cap'      // the 24h spend cap is reached: the queue holds until it scrolls or you raise it
  | 'node_unreachable' // the card names a paired node and the node did not answer: it waits THERE, never here
  | 'project-paused' // the project hit its quota limit: automated work waits for "Continua" or the reset
  | 'plan_window'    // the subscription's five-hour window is nearly gone: the queue waits for the reset
  | 'checklist_frozen' // in review senza domande aperte, ma con la checklist aperta: approvarla non la chiude
  | 'children_parked' // sta CHIEDENDO cosa fare dei suoi step fermi: il chip ne porta il numero
  | 'parked'         // in backlog: il dispatcher non guarda questa colonna
  | 'no_agent'       // in corso, ma nessun agente dentro e nessuno che la reclami
  | 'unknown';       // il server non è riuscito a calcolarla: il buco, dichiarato

/**
 * COSA SUCCEDE DOPO, in tre pezzi. Il tono è la parte che si legge a un metro.
 *
 * `queued` = la coda scorre, non devi fare niente. `waiting` = ferma ma
 * riparte da sola (una condizione esterna, un altro task, un turno altrui).
 * `stalled` = non riparte finché non decidi tu. È la distinzione che oggi non
 * si vede: «aspetta uno slot» e «non partirà mai» sono la stessa parola «in
 * coda», e chi guarda non sa se aspettare o intervenire.
 */
export type QueueTone = 'queued' | 'waiting' | 'stalled';

/**
 * La ragione, pronta da scrivere. `head · detail` è il testo del chip, `title`
 * il tooltip che dice per esteso cosa succede dopo.
 *
 * La FRASE viaggia già composta, non i campi da cui dedurla: il client la
 * rende, non la calcola. È lo stesso conto già pagato con `waitingOnCount` —
 * il giorno che il dispatcher cambia una regola, un client che deduce continua
 * a rispondere, con sicurezza, la risposta di ieri.
 */
/** The chip of a card held by its project's pause (the i18n catalogue renders `key`). */
export const PROJECT_PAUSED_REASON: QueueReason = { kind: 'project-paused', tone: 'waiting', key: 'board.queue.projectPaused' };

export interface QueueReason {
  kind: QueueReasonKind;
  tone: QueueTone;
  /**
   * The i18n BASE key of the sentence, chosen here and rendered by whoever
   * draws. `<key>.head`, `<key>.detail` and `<key>.title` are the three
   * strings of the chip.
   *
   * The key and not the words: the phrase used to travel already composed, in
   * Italian, from a module the language selector cannot reach. The reason for
   * composing it here has not changed and is not weakened by this, because it
   * was never about the words: the DECISION of which branch applies belongs to
   * the side that decides not to dispatch. A client that picked the branch
   * itself would keep answering yesterday's rule, with a confident face, the
   * day the dispatcher changes. It still does not pick: it receives a key.
   *
   * Several kinds have more than one key, because a singular and a plural, or
   * "in Backlog" and "in Review", are two sentences and not one sentence with
   * a hole in it.
   */
  key: string;
  /** The values the sentence interpolates: `{n}`, `{ahead}`, `{clock}`. */
  params?: Record<string, string | number>;
}

/**
 * The base keys each kind can emit. A kind with more than one entry is a kind
 * whose sentence changes shape, not just its numbers: one step against three,
 * a deferral in minutes against one on the clock, Backlog against Review.
 * @internal Parity guard: the catalogue tests walk it so every kind has its i18n keys in both languages.
 */
export const QUEUE_REASON_MESSAGE_KEYS: Record<QueueReasonKind, string[]> = {
  slot: ['board.queue.slot.first', 'board.queue.slot.ahead'],
  blocked: ['board.queue.blocked.named', 'board.queue.blocked.anon'],
  deferred: [
    'board.queue.deferred.soon', 'board.queue.deferred.soonBecause',
    'board.queue.deferred.later', 'board.queue.deferred.laterBecause',
  ],
  attempts: ['board.queue.attempts'],
  dispatch_off: ['board.queue.dispatchOff'],
  no_project: ['board.queue.noProject'],
  parent_review: ['board.queue.parentReview'],
  parent_turn: ['board.queue.parentTurn'],
  parent_idle: ['board.queue.parentIdle'],
  heavy_hold: ['board.queue.heavyHold.alone', 'board.queue.heavyHold.blocking'],
  heavy_busy: ['board.queue.heavyBusy'],
  resource_floor: ['board.queue.resourceFloor', 'board.queue.memory.measured', 'board.queue.memory.measuring'],
  resource_pressure: ['board.queue.resourcePressure'],
  spend_cap: ['board.queue.spendCap'],
  node_unreachable: ['board.queue.nodeUnreachable'],
  'project-paused': ['board.queue.projectPaused'],
  plan_window: ['board.queue.planWindow'],
  checklist_frozen: ['board.queue.checklistFrozen.one', 'board.queue.checklistFrozen.many'],
  children_parked: ['board.queue.childrenParked.one', 'board.queue.childrenParked.many'],
  parked: [
    'board.queue.parked.backlog', 'board.queue.parked.backlogBecause',
    'board.queue.parked.review', 'board.queue.parked.reviewBecause',
  ],
  no_agent: [
    'board.queue.noAgent', 'board.queue.noAgent.minutes', 'board.queue.noAgent.hours',
    'board.queue.noAgent.node', 'board.queue.noAgent.cloud', 'board.queue.noAgent.pr',
  ],
  unknown: ['board.queue.unknown'],
};

/**
 * The `dispatch_error` a silent node writes on the card. A SENTINEL, not prose:
 * the branch that reads it must not depend on the wording of a message, which
 * is the kind of predicate that goes quietly false the day somebody rewords it.
 */
export const NODE_UNREACHABLE_ERROR = 'node_unreachable';

/** Il contesto che la ragione non può leggere dalla riga del task. */
export interface QueueContext {
  /** Adesso, in ISO — la finestra di rinvio si misura da qui. */
  now: string;
  /** L'interruttore di dispatch della board (o quello globale). */
  autoDispatch: boolean;
  /**
   * The NAME of the node the card names, when the caller could resolve it. The
   * chip names the node, and an id in that sentence would name nothing to
   * whoever reads it.
   */
  nodeName?: string | null;
  /** Il tetto dei tentativi della board (`BoardSettings.dispatchRetryCap`). */
  retryCap: number;
  /**
   * Quanti task idonei il dispatcher servirebbe PRIMA di questo. Contato sul
   * DB con la stessa disciplina di coda del tick (priorità, poi anzianità):
   * dalla lista che il client ha in mano non si può contare, perché quella è
   * un progetto solo, `rootsOnly`, non archiviati.
   */
  ahead: number;
  /**
   * Questo task è PESANTE e il dispatcher lo sta trattenendo (chip `queued`).
   *
   * Non è «aspetta il suo turno»: il ramo trattenuto del tick fa `break`, quindi
   * finché aspetta lui non parte NESSUNO. È la differenza che la board non
   * sapeva dire, e costava ore: la notte del 12/08 quaranta card idonee e due
   * `in_progress` col tetto a 9, tutte con lo stesso chip «in coda» addosso.
   */
  heavyHeld?: boolean;
  /**
   * C'è un task PESANTE con un agente vivo ADESSO — su qualunque board.
   *
   * È l'ALTRO ramo del peso, e non è una sfumatura di `heavyHeld`: il tick esce
   * prima del ciclo (`if (heavyBusy) { … return; }`) mettendo il chip `queued`
   * su OGNI todo. Quindi vale anche per le card leggere, l'ordine della fila non
   * lo legge nessuno, l'attesa non ha tetto (dura quanto quel turno) e la
   * priorità non sblocca niente.
   *
   * Serve perché senza, quelle card cadevano sulla frase della fila — «in coda,
   * 3 davanti» — che è la parola vaga da togliere: la sera del 12/08 tre card
   * ferme per questo motivo, il motivo scritto nel THREAD di ognuna, e sulla
   * card solo il chip generico.
   */
  heavyInFlight?: boolean;
  /** Quanti task idonei stanno DIETRO: quelli che il `break` sta fermando. */
  behind?: number;
  /**
   * THE FLOOR AND THE CEILING, the two blocks that stop the WHOLE machine.
   *
   * The tick reads them once per round (`admissionBlock() ?? dayBlock()`) and
   * skips every card of every board: not one slot is missing, no slot is going
   * to free up, and nothing moves until the disk, the RAM or the 24h spend
   * window says otherwise. Without this the card fell through to `slot` and
   * said "queued · next up" for hours, which is the opposite of what happens.
   *
   * `reason` is the sentence the block itself composed, with its numbers: it
   * travels because those numbers are the answer ("2.1 GB free against a floor
   * of 3"), and recomputing them on the client would mean measuring another
   * machine.
   *
   * For a resume held in the In-progress column it is the block of THAT hold,
   * not the published one (`heldResumeBlock` in `dispatch-block-signal.ts`).
   */
  dispatchBlock?: { kind: 'resources' | 'pressure' | 'spend' | 'plan' | 'paused'; reason: string } | null;
  /** The card's project is paused by its quota limit (read from the project row, never the machine). */
  projectPaused?: boolean;
  /**
   * THE MEMORY GATE'S TWO NUMBERS, for a card held by the memory queue (its row
   * says `waiting-memory`): the line one more card needs and the lowest free
   * reading of the window, `null` while the window fills. Measured by the
   * dispatcher each round (`dispatch-block-signal.ts`). Absent = no reading:
   * the card says it waits for memory without a number, never a stale one.
   */
  memoryWait?: { needGB: number; freeGB: number | null } | null;
  /**
   * WHERE an In-progress card works when no agent of this machine is in it.
   * `node` = a paired computer, `cloud` = a Claude cloud session (the cloud
   * node, or a session link in the thread), `pr` = a pull request the card
   * points at. Resolved by the mapper, which can read the node names and the
   * thread; `null` = nothing says it works anywhere.
   */
  elsewhere?: { where: 'node' | 'cloud' | 'pr'; label: string } | null;
  /** Lo stato del padre, per uno step. `null` = non è uno step, o padre sparito. */
  parentStatus: TaskStatus | string | null;
  /** Vero quando il task non ha una board con una directory (`_none`). */
  projectless: boolean;
  /**
   * Quanti sottotask aperti (non chiusi, non archiviati) ha questa card.
   *
   * Il client non lo ha: la sua lista è un progetto solo, `rootsOnly`, non
   * archiviati, e i figli non ci stanno dentro. `subtaskCount` sul payload non
   * risponde nemmeno lui: lo riempiono soltanto `list` e `get`, DOPO
   * `rowToTask`, quindi su ogni scrittura sarebbe zero proprio mentre l'umano
   * guarda la card che ha appena mosso.
   */
  openSubtasks: number;
  /**
   * Come si scrive un orario. Iniettabile perché il ramo «riprende alle 06:40»
   * dipende dal fuso della macchina, e un test che ci gira sopra non deve
   * dipendere da dove gira.
   */
  formatTime?: (iso: string) => string;
}

/**
 * IL BUCO, DICHIARATO. Quando il server non riesce a calcolare la ragione, la
 * card lo dice invece di ripiegare su una parola generica.
 *
 * «In coda» al posto di una ragione mancante non è un ripiego prudente: è la
 * stessa bugia di prima, con l'aggravante di sembrare una risposta. Un buco
 * detto ad alta voce è informazione — chi guarda sa che deve aprire il task, e
 * chi legge un rosso sa che c'è un guasto da guardare.
 */
export const QUEUE_REASON_UNKNOWN: QueueReason = {
  kind: 'unknown', tone: 'stalled', key: 'board.queue.unknown',
};

/** Ore e minuti, 24h — il default di `QueueContext.formatTime`. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Sotto questa soglia il rinvio si dice in minuti («fra 12 min») invece che con
 * l'orologio. Un'attesa breve la si misura, non la si legge sul quadrante — e
 * «riprende alle 06:52» a un'attesa di due minuti fa sembrare fermo qualcosa
 * che sta per ripartire.
 */
const NEAR_DEFERRAL_MIN = 90;

/** Le prime otto lettere dell'id: quanto basta a riconoscerlo sulla board. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Le colonne in cui una promessa di ritorno in coda è una bugia, dette a parole. */
const OUT_OF_QUEUE: Record<'backlog' | 'review', string> = {
  backlog: 'board.queue.parked.backlog',
  review: 'board.queue.parked.review',
};

/**
 * LA PROMESSA CHE NESSUNO MANTIENE, in una colonna che non è una coda.
 *
 * `dispatch_state = 'waiting'` disegna «rinviata: aspetta una condizione
 * esterna, lo slot è libero, riparte da sola», e lo disegna in QUALUNQUE
 * colonna: è una mappa da uno stato a una frase, e la colonna non la guarda
 * nessuno (`DISPATCH_CHIP` in `components/Board/constants.ts`). Ma il rinvio lo
 * onora il tick, e il tick reclama `status = 'todo'`: da ogni altra colonna
 * quella finestra scade senza che nessuno la stia guardando.
 *
 * Misurato il 13/08 sul database vivo, quattro card col chip addosso e tre che
 * mentivano: una in Backlog con la finestra scaduta il 3 agosto, due in Review
 * con rinvii dell'11, e una sola in Todo che diceva il vero.
 *
 * Si parla SOLO sopra la promessa: senza `waiting` e senza una finestra, una
 * card in Backlog è semplicemente parcheggiata e la colonna lo dice già da sé —
 * ripeterlo su ognuna sarebbe rumore. `null` significa esattamente questo.
 */
function outOfQueuePromise(
  task: { dispatchState: string | null | undefined; dispatchDeferredUntil: string | null | undefined; dispatchError?: string | null },
  column: 'backlog' | 'review',
): QueueReason | null {
  if (task.dispatchState !== 'waiting' && !task.dispatchDeferredUntil) return null;
  const base = OUT_OF_QUEUE[column];
  // What it was waiting FOR is the one thing the column cannot say by itself,
  // so it gets its own sentence rather than a hole that is empty half the time.
  const because = task.dispatchError ? `${base}Because` : base;
  return {
    kind: 'parked', tone: 'stalled', key: because,
    params: task.dispatchError ? { reason: task.dispatchError } : undefined,
  };
}

/**
 * PERCHÉ questa card è ferma, in una frase.
 *
 * Pura per costruzione: prende la riga e il contesto, non tocca né DB né
 * orologio (l'adesso arriva in `ctx.now`). La CHIAMA il server, dove vive la
 * decisione di non dispacciare; il client riceve `head`/`detail`/`title` già
 * scritti e li disegna.
 *
 * Torna `null` quando la domanda non si pone: la card è chiusa, oppure un agente
 * ci sta già girando sopra (lì il chip di dispatch dice già tutto), oppure la
 * card sta già CHIEDENDO qualcosa a chi guarda (`needs_input`) e quella domanda
 * è la mossa da fare, oppure la colonna in cui sta è già la risposta (una card
 * in Backlog che non promette niente è parcheggiata, e si vede da sola).
 *
 * FUORI DA TODO LA COLONNA NON È UNA CODA, e il chip di dispatch non lo sa. Il
 * tick reclama solo `todo`: `waiting` — «rinviata: riparte da sola» — è una
 * promessa che nessuno mantiene in Backlog e in Review (misurate il 13/08 sul
 * database vivo quattro card col chip addosso e tre che mentivano: una in
 * Backlog con la finestra scaduta il 3 agosto, due in Review con rinvii
 * dell'11), e una card `in_progress` senza chip non diceva niente mentre nessuno
 * la lavorava (quattro così, sulla stessa board). Le altre colonne entrano qui
 * per questo: la ragione vince sul chip di dispatch (`Card.tsx`), quindi è
 * l'unico posto da cui quella promessa si può correggere.
 *
 * L'ORDINE È QUELLO DEL DISPATCHER, e non è cosmetico:
 *  1. uno step non viene mai reclamato (il tick lista `rootsOnly`): la sua
 *     ragione è sempre il padre, qualunque altra cosa abbia addosso;
 *  2. senza board non c'è cwd, e il tick esce prima di guardare qualsiasi cosa;
 *  3. rinvio e bloccante vengono PRIMA del budget dei tentativi — è lo stesso
 *     ordine che il tick applica, e invertirlo ucciderebbe una card che sta
 *     solo aspettando (già successo, l'11/08, a una card in attesa di UAT);
 *  4. l'interruttore spento viene per ULTIMO, appena prima della coda: è una
 *     proprietà della board e non della card, e messo per primo cancellerebbe
 *     da quaranta card la sola cosa vera di ciascuna.
 */
export function deriveQueueReason(
  task: {
    status: TaskStatus | string;
    parentTaskId: string | null | undefined;
    dispatchState: string | null | undefined;
    dispatchAttempts: number;
    dispatchDeferredUntil: string | null | undefined;
    dispatchError?: string | null;
    /** A scheduled run outside Topics works this card: it is not in the queue, and the card front says who and when. */
    scheduledBy?: string | null;
    /**
     * CHI ha portato la card in review, quando non è stato l'agente. Serve a un
     * ramo solo — distinguere la domanda di sistema sui figli fermi da tutte le
     * altre — ma è la differenza fra un chip che dice «serve te» e uno che dice
     * anche quanto lavoro c'è sotto.
     */
    deliveredReason?: string | null;
    blockedByTaskId: string | null | undefined;
    blockedBy: BlockerRef | null | undefined;
    /**
     * A chi è assegnata, se a una persona. Serve a UNA riga sola: una card
     * `in_progress` senza agente è ferma, tranne quando è una persona ad averla
     * presa in mano («Serve a me» scrive qui). Lì «in corso» è vero, e il chip
     * sarebbe un allarme su qualcuno che sta lavorando.
     */
    assignedTo?: string | null;
    /**
     * The paired node this card was chosen to run on, when there is one. It
     * changes ONE branch: a deferral whose cause is a silent node is not the
     * generic "it starts again at 06:52", it is "the machine you picked did
     * not answer". The two ask different things of whoever reads them: one
     * waits, the other goes and looks at the node.
     */
    machineId?: string | null;
    /** Last write on the row: how long an In-progress card has had no agent. */
    updatedAt?: string | null;
  },
  ctx: QueueContext,
): QueueReason | null {
  // REVIEW CON LA CHECKLIST APERTA: l'unico stato fuori da `todo` in cui la
  // domanda si pone, perché è l'unico in cui «ferma» ha una causa che la card
  // non mostra. Sembra una consegna che aspetta una persona, ma quella persona
  // non ha mosse: approvare porta a `done`, e `done` con un sottotask aperto è
  // rifiutato (`open_subtasks`); i sottotask non li dispaccia nessuno da solo,
  // li lavora l'agente del padre dentro un turno che qui è già finito. Otto
  // card così nella notte del 12/08, e il motivo viveva solo nel log di una
  // sonda che nessuno lancia.
  if (task.status === 'review') {
    if (ctx.openSubtasks <= 0) return outOfQueuePromise(task, 'review');
    // LA CARD CHE STA GIÀ CHIEDENDO NON SI ZITTISCE. `needs_input` è l'unico
    // stato in cui la card porta addosso una DOMANDA con una risposta possibile:
    // quella di sistema sui figli parcheggiati, che arriva coi due bottoni
    // («rimettili in coda» / «archiviali»), o quella vera dell'agente, che si
    // risponde nella sessione. Il chip rosa «serve te» dice esattamente quella
    // mossa; qui si legge «ferma», e il tooltip consiglia o cose che sono già
    // sullo schermo o, sulla domanda dell'agente, tutto tranne rispondere.
    //
    // È anche l'unica riga su cui questa funzione e la sonda
    // (`scripts/stalled-parents.ts`) potevano dare risposta OPPOSTA: la sonda
    // esclude `review + delivered_reason = 'parked_children'` dicendo «sta già
    // chiedendo». I due predicati restano diversi perché rispondono a due
    // domande diverse — «ha una mossa sullo schermo» contro «è uno stallo muto»
    // — ma il primo CONTIENE il secondo: `askParkedChildren` scrive
    // `needs_input` e `parked_children` nella stessa UPDATE. Il contenimento è
    // provato, non sperato, in `tasks.queue-reason.test.ts`.
    //
    // `delivered` invece perde il suo chip verde, ed è voluto: quello non chiede
    // niente, dice che si può chiudere — e con un sottotask aperto approvare
    // viene rifiutato (`open_subtasks`). È esattamente la bugia da togliere.
    // ...con UNA eccezione: la domanda di sistema sui figli fermi. Lì il chip
    // rosa dice la mossa («serve te») ma non dice QUANTO — e il numero è la sola
    // parte che si legge dalla colonna senza aprire il drawer. Il 13/08 sette
    // padri tenevano ferme ventuno card, e da fuori non si vedeva né quali né
    // quante: le colonne Backlog e Todo si disegnavano vuote perché la board
    // fetcha `rootsOnly`, e gli step non ci stanno dentro.
    //
    // Il conto è quello dei figli aperti, ed è esatto per costruzione:
    // `askParkedChildren` firma `parked_children` solo quando NESSUN figlio è in
    // volo, quindi in questo ramo «aperto» e «fermo» sono lo stesso insieme.
    if (task.dispatchState === 'needs_input') {
      if (task.deliveredReason !== 'parked_children') return null;
      const n = ctx.openSubtasks;
      return {
        kind: 'children_parked', tone: 'stalled',
        key: n === 1 ? 'board.queue.childrenParked.one' : 'board.queue.childrenParked.many',
        params: { n },
      };
    }
    const n = ctx.openSubtasks;
    return {
      kind: 'checklist_frozen', tone: 'stalled',
      key: n === 1 ? 'board.queue.checklistFrozen.one' : 'board.queue.checklistFrozen.many',
      params: { n },
    };
  }

  // Una card chiusa non aspetta niente: la domanda non si pone.
  if (task.status === 'done') return null;

  // Un agente già in volo su questa riga: il chip del ciclo di vita
  // («avvio…», «al lavoro») dice più di qualunque ragione di coda.
  if (task.dispatchState === 'starting' || task.dispatchState === 'working') return null;

  // ── LE ALTRE COLONNE CHE NON SONO UNA CODA ─────────────────────────────────
  // Il tick reclama `status = 'todo'` e basta. Da qui non riparte niente da
  // solo, quindi ogni frase che promette un ritorno è falsa e va sostituita.
  //
  // Il bloccante NON entra: ha una riga sua sulla card (`blockedByChip`), e la
  // sua frase — «quando quello chiude questa torna in coda da sé» — sarebbe
  // proprio la promessa che qui non vale. Meglio il chip che c'è già.
  if (task.status === 'backlog' || task.status === 'in_progress') {
    // A RESUME HELD BY THE MACHINE is not an agent about to be born. `resume`
    // puts the same `queued` chip on an In-progress card when the floor or the
    // budget holds it, and after a forced restart that is every cut turn at
    // once: twelve queued chips with no reason while nothing starts.
    // The block here is the one that holds THIS resume (the mapper passes the
    // hold's own, never the tick's), and it is said with the words the todo
    // branch uses. Not the switch first: `resume` re-evaluates its hold on its
    // own timer whatever the switch says, so with dispatch off this card still
    // starts the moment the floor clears, and "nothing starts until you turn
    // dispatch back on" would be the false sentence.
    if (task.status === 'in_progress' && task.dispatchState === 'queued' && !task.parentTaskId && ctx.dispatchBlock) {
      return machineBlockReason(ctx.dispatchBlock, ctx.memoryWait);
    }
    // `queued` compreso: fuori da `todo` quel chip non è la parola vaga che
    // questa funzione sostituisce, è un agente che sta per nascere.
    if (isAgentWorking(task.dispatchState)) return null;
    // Uno step in corso ha già la sua frase, e non è una ragione di coda: chi lo
    // lavora lo dice `deriveSubtaskWork` («la lavora il padre», «nessun antenato
    // al lavoro»), che sa risalire l'albero. Due frasi sulla stessa card
    // finirebbero per contraddirsi.
    if (task.parentTaskId) return null;

    if (task.status === 'in_progress') {
      // Presa da una persona: «in corso» è vero, e non c'è niente da dire.
      if (task.assignedTo) return null;
      return noAgentReason(task.updatedAt ?? null, ctx);
    }

    // In Backlog si TACE, di regola: quella colonna è il parcheggio, e dirlo
    // su ogni card sarebbe ripetere l'ovvio dove sta scritto. Si parla solo
    // sopra una PROMESSA — il chip `waiting` o una finestra di rinvio — perché
    // quella promessa è l'unica cosa che la colonna non smentisce da sé.
    return outOfQueuePromise(task, 'backlog');
  }

  if (task.status !== 'todo') return null;

  // Planned work, not queued work: no queue sentence would be true here.
  if (task.scheduledBy) return null;

  if (task.parentTaskId) {
    if (ctx.parentStatus === 'review') {
      return { kind: 'parent_review', tone: 'stalled', key: 'board.queue.parentReview' };
    }
    if (ctx.parentStatus === 'in_progress') {
      return { kind: 'parent_turn', tone: 'waiting', key: 'board.queue.parentTurn' };
    }
    return { kind: 'parent_idle', tone: 'stalled', key: 'board.queue.parentIdle' };
  }

  if (ctx.projectless) {
    return { kind: 'no_project', tone: 'stalled', key: 'board.queue.noProject' };
  }

  // BEFORE the generic deferral, and that is the whole point. A card held back
  // because its node is silent carries a deferral like any other, so the
  // generic branch would swallow it and print a clock. The card would then
  // look about to restart by itself, which is exactly what it is not doing:
  // nothing on this side fixes a machine that is off (KANBAN-76).
  if (task.machineId && task.dispatchError === NODE_UNREACHABLE_ERROR) {
    return {
      kind: 'node_unreachable', tone: 'stalled', key: 'board.queue.nodeUnreachable',
      params: { node: ctx.nodeName ?? task.machineId },
    };
  }

  const until = task.dispatchDeferredUntil;
  if (until && until > ctx.now) {
    const min = Math.max(1, Math.round((new Date(until).getTime() - new Date(ctx.now).getTime()) / 60000));
    const soon = min <= NEAR_DEFERRAL_MIN;
    const base = soon ? 'board.queue.deferred.soon' : 'board.queue.deferred.later';
    const params: Record<string, string | number> = soon
      ? { min }
      : { clock: (ctx.formatTime ?? formatClock)(until) };
    if (task.dispatchError) params.reason = task.dispatchError;
    return {
      kind: 'deferred', tone: 'waiting',
      key: task.dispatchError ? `${base}Because` : base,
      params,
    };
  }

  const b = task.blockedBy;
  const blockerOpen = !!task.blockedByTaskId && !(b && (b.status === 'done' || b.archived));
  if (blockerOpen) {
    return {
      kind: 'blocked', tone: 'waiting',
      key: b ? 'board.queue.blocked.named' : 'board.queue.blocked.anon',
      params: b
        ? { id: shortId(task.blockedByTaskId!), who: b.text }
        : { id: shortId(task.blockedByTaskId!) },
    };
  }

  if (task.dispatchAttempts >= ctx.retryCap) {
    return {
      kind: 'attempts', tone: 'stalled', key: 'board.queue.attempts',
      params: { attempts: task.dispatchAttempts, cap: ctx.retryCap },
    };
  }

  // L'interruttore viene DOPO le ragioni della card, e non prima. È una
  // proprietà della board, non di questa riga: scriverlo per primo lo
  // stamperebbe identico su quaranta card e coprirebbe l'unica cosa che di
  // ognuna è vera in proprio. Quello che sostituisce è la sola risposta che a
  // interruttore spento sarebbe una bugia: «in coda, N davanti» — non c'è
  // nessuna coda che scorre.
  if (!ctx.autoDispatch) {
    return { kind: 'dispatch_off', tone: 'stalled', key: 'board.queue.dispatchOff' };
  }

  // PROJECT PAUSE. The dispatcher skips this card (claim gate) or holds its
  // resume until "Continua" or the reset: no slot is missing, so "in queue, next"
  // would be false. Tone `waiting`: it restarts by itself.
  if (ctx.projectPaused) return PROJECT_PAUSED_REASON;

  // Un pesante trattenuto non «aspetta uno slot»: è il tappo. Viene dopo
  // l'interruttore (a dispatch spento non c'è nessuna coda da tappare) e prima
  // della fila, perché «in coda, 0 davanti» su una board immobile è vero alla
  // lettera e completamente fuorviante: fa sembrare che manchi un posto, mentre
  // il posto c'è e a non muoversi è la fila intera per colpa di questa riga.
  if (ctx.heavyHeld) {
    const behind = ctx.behind ?? 0;
    return {
      kind: 'heavy_hold', tone: 'waiting',
      key: behind === 0 ? 'board.queue.heavyHold.alone' : 'board.queue.heavyHold.blocking',
      params: { behind },
    };
  }

  // L'ALTRO ramo del peso: non è questa card a tenere la coda, è un turno
  // pesante altrui che si prende la macchina da solo. Viene dopo `heavyHeld`
  // (i due si escludono: quello porta `&& !heavyInFlight()`) e prima della
  // fila, perché la fila qui non la legge nessuno — il tick esce prima del
  // ciclo, quindi «3 davanti» descriverebbe un ordine che nessuno applica.
  //
  // Le quattro cose che NON si possono dire, e che la frase del carico dice
  // tutte: che questa card tiene la testa della coda (l'ordine è irrilevante),
  // che aspetta margine (aspetta un turno, non il carico), che parte entro il
  // tetto d'attesa (quel tetto conta il carico, non il turno altrui), che
  // abbassarle la priorità sblocca qualcosa (non sblocca niente). Restano il
  // fatto e la mossa: non c'è mossa, riparte da sé.
  if (ctx.heavyInFlight) {
    return { kind: 'heavy_busy', tone: 'waiting', key: 'board.queue.heavyBusy' };
  }

  // THE INVISIBLE BRAKE. Under the RAM/disk floor, or over the 24h spend cap,
  // the tick skips EVERY card and puts the same `queued` chip on all of them.
  // Falling through to the queue branch, the card said "in coda, la prossima"
  // with the tooltip "it starts as soon as an agent slot frees up": no slot is
  // missing, none is going to free up, and the board sits still for hours while
  // every card claims the opposite.
  //
  // Tone `stalled` for both: a disk does not empty itself and a cap is raised
  // by a person. The spend one is second because the tick reads it second
  // (`admissionBlock() ?? dayBlock()`), and a machine out of RAM does not start
  // anything even with the ledger at zero.
  if (ctx.dispatchBlock) return machineBlockReason(ctx.dispatchBlock, ctx.memoryWait);

  return {
    kind: 'slot', tone: 'queued',
    key: ctx.ahead === 0 ? 'board.queue.slot.first' : 'board.queue.slot.ahead',
    params: { ahead: ctx.ahead },
  };
}

/** The reason of a block that holds the whole machine, one mapping for every
 *  column that can be held by it (a Todo card, and a held resume in progress). */
function machineBlockReason(
  block: NonNullable<QueueContext['dispatchBlock']>,
  memoryWait?: QueueContext['memoryWait'],
): QueueReason {
  // THE MEMORY QUEUE says its two numbers, not its code. Its row carries
  // `waiting-memory` (KANBAN-97) where the floor carries a sentence, and the
  // generic branch printed "the machine is out of room" with the code itself
  // at the end of the tooltip: ten cards so on 26/10, and none of them said
  // how far the machine was from starting it. Tone `waiting`: the memory is
  // the other applications', and they give it back without anybody's move.
  if (block.kind === 'resources' && block.reason === WAITING_MEMORY_REASON) {
    const need = memoryWait && Number.isFinite(memoryWait.needGB) ? roundGB(memoryWait.needGB) : null;
    const free = memoryWait?.freeGB != null && Number.isFinite(memoryWait.freeGB) ? roundGB(memoryWait.freeGB) : null;
    if (need != null && free != null) {
      return {
        kind: 'resource_floor', tone: 'waiting', key: 'board.queue.memory.measured',
        params: { need, free, missing: roundGB(Math.max(0, memoryWait!.needGB - memoryWait!.freeGB!)) },
      };
    }
    return { kind: 'resource_floor', tone: 'waiting', key: 'board.queue.memory.measuring' };
  }
  // THE THIRD KIND is the one that does come back on its own, and that is why
  // it is not folded into the floor: «per risorse» holds the queue while the
  // machine is over the chosen threshold, and load drops by itself the moment
  // whatever is busy stops. Tone `waiting`, not `stalled`: nobody has to do
  // anything, unlike a full disk or a spend cap a person has to raise.
  if (block.kind === 'paused') return PROJECT_PAUSED_REASON;
  const kind: QueueReasonKind =
    block.kind === 'spend' ? 'spend_cap'
      : block.kind === 'pressure' ? 'resource_pressure'
        : block.kind === 'plan' ? 'plan_window'
          : 'resource_floor';
  const key =
    kind === 'spend_cap' ? 'board.queue.spendCap'
      : kind === 'resource_pressure' ? 'board.queue.resourcePressure'
        : kind === 'plan_window' ? 'board.queue.planWindow'
          : 'board.queue.resourceFloor';
  return {
    kind,
    // THE FOURTH KIND waits like the third and for the same reason: the
    // plan's window refills at a published hour, so nobody has to do
    // anything. It is not folded into the spend cap even though both are a
    // budget, because a cap is raised by a person and a window is not.
    tone: kind === 'resource_pressure' || kind === 'plan_window' ? 'waiting' : 'stalled',
    key,
    params: { reason: block.reason },
  };
}

/** The code a card held by the memory queue carries in `dispatch_error`. */
export const WAITING_MEMORY_REASON: DispatchMemoryQueueReason = 'waiting-memory';

/** One decimal, as a number: the catalogue's `{need}` and `{free}`. */
function roundGB(gb: number): number {
  return Math.round(gb * 10) / 10;
}

/**
 * An In-progress card with no agent of this machine in it: WHERE it works, or
 * for how long nothing has moved.
 *
 * The bare "no agent" was the same word on two cards that ask opposite things
 * (26/10): one whose work runs in a cloud session, which needs nobody, and one
 * that is simply stopped, which needs somebody to put it back in Todo. Where
 * it runs comes first because it is the answer to "is anyone on it"; the time
 * since the last write is the number that tells a stop of minutes from one of
 * a day.
 */
function noAgentReason(updatedAt: string | null, ctx: QueueContext): QueueReason {
  const away = ctx.elsewhere;
  if (away) {
    return {
      kind: 'no_agent', tone: 'waiting', key: `board.queue.noAgent.${away.where}`,
      params: { where: away.label },
    };
  }
  const ms = updatedAt ? new Date(ctx.now).getTime() - new Date(updatedAt).getTime() : Number.NaN;
  if (!Number.isFinite(ms) || ms < 0) return { kind: 'no_agent', tone: 'stalled', key: 'board.queue.noAgent' };
  const min = Math.max(1, Math.round(ms / 60000));
  return min < 60
    ? { kind: 'no_agent', tone: 'stalled', key: 'board.queue.noAgent.minutes', params: { n: min } }
    : { kind: 'no_agent', tone: 'stalled', key: 'board.queue.noAgent.hours', params: { n: Math.round(min / 60) } };
}
