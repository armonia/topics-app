/**
 * La SCHEDA di un task e la SESSIONE che lo lavora sono due superfici diverse,
 * e questo modulo dice quando la seconda esiste.
 *
 * LE DUE COSE.
 *  - La SCHEDA (`/task/<id>`, vedi `openTaskLink.ts`): titolo, descrizione,
 *    checklist, consegna, thread. È dove si DECIDE. Esiste sempre — anche a task
 *    chiuso, anche con l'agente morto da giorni.
 *  - La SESSIONE (`assignedTopicId`): la chat viva dell'agente, coi suoi turni,
 *    il suo contesto e il suo terminale. È dove si LAVORA. Esiste solo finché
 *    c'è un agente, e può sparire (worktree potata, topic cancellato).
 *
 * IL GUASTO CHE CHIUDE. `assignedTopicId` non è una prova di vita: è l'id che il
 * dispatcher ha scritto quando ha aperto la sessione, e resta lì per sempre.
 * Cliccare "apri la sessione" su un id che non risolve più portava a due esiti,
 * entrambi muti: in una finestra di progetto `reopenTopicLocal` fa `return` se
 * `topics[topicId]` non c'è (nessun feedback, il bottone sembra rotto), fuori
 * `openPanel` registra comunque la pane e apre un rettangolo "Topic not found".
 * Il gesto deve dire PRIMA del click che la sessione non c'è.
 *
 * PERCHÉ UN INSIEME DI ID E NON LA MAPPA DEI TOPIC. La mappa cambia identità a
 * ogni metadato che si muove (un turno che streamma tocca `updatedAt`), e le
 * card della board sono memoizzate: passare la mappa vorrebbe dire ridisegnare
 * ogni colonna a ogni token. L'insieme delle CHIAVI cambia solo quando un topic
 * nasce o muore, cioè esattamente quando questa risposta può cambiare.
 *
 * UN VUOTO NON È UNA MORTE. Stessa lezione di `hooks/rosterTrust.ts`: un insieme
 * vuoto ha due significati che il tipo non distingue — "non ci sono topic" e
 * "non li ho ancora caricati". Al boot, e per ogni finestra che monta la board
 * prima dell'indice dei topic, il secondo è la norma; dichiarare morte tutte le
 * sessioni in quella finestra significherebbe spegnere il gesto proprio mentre
 * l'agente lavora. Quindi: vuoto ⇒ `unknown`, e `unknown` lascia passare.
 */

/** In che stato è la sessione di lavoro di un task. */
export type TaskSessionState =
  /** Il task non è mai stato dispatchato: non c'è nessuna sessione da aprire. */
  | 'never'
  /** Il topic dell'agente esiste: il gesto porta a una chat vera. */
  | 'alive'
  /** C'era una sessione, il suo topic non c'è più: l'agente non è più vivo. */
  | 'gone'
  /** Non lo sappiamo ancora (indice dei topic non caricato). Non si decide. */
  | 'unknown';

/**
 * Lo stato della sessione di un task, dato l'insieme dei topic che esistono.
 *
 * `aliveTopicIds` sono gli id dei topic conosciuti dal client, ARCHIVIATI
 * INCLUSI: archiviato ≠ morto — nel modello a due stati aprire una chat chiusa
 * la riapre, ed è proprio ciò che fa `openPanel`. Morto è solo ciò che non è
 * più nell'indice.
 */
export function taskSessionState(
  assignedTopicId: string | null | undefined,
  aliveTopicIds: ReadonlySet<string>,
): TaskSessionState {
  if (!assignedTopicId) return 'never';
  if (aliveTopicIds.has(assignedTopicId)) return 'alive';
  // Vedi l'intestazione: un indice vuoto è "non lo so", non "non c'è più".
  if (aliveTopicIds.size === 0) return 'unknown';
  return 'gone';
}

/**
 * Il gesto "apri la sessione" va offerto?
 *
 * `unknown` passa di proposito: nel dubbio si prova ad aprire (il peggio è la
 * pane che già si vedeva), mentre spegnere il bottone su una sessione viva
 * sarebbe il bug opposto e più grave. `never` non passa perché non c'è niente
 * da mostrare; `gone` non passa perché il vuoto va DETTO, non aperto.
 */
export function canOpenTaskSession(state: TaskSessionState): boolean {
  return state === 'alive' || state === 'unknown';
}

/** Il gesto va MOSTRATO ma spento, con la ragione? Solo quando c'era e non c'è più. */
export function shouldExplainMissingSession(state: TaskSessionState): boolean {
  return state === 'gone';
}
