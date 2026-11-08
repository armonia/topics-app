/**
 * Il tempo che un turno passa fermo ad aspettare l'umano — tenuto a parte.
 *
 * `latencyMs` è la durata che resta scritta sotto il messaggio finito, per
 * sempre. Finora era `fine - inizio`, e quando in mezzo c'era una domanda quel
 * numero comprendeva il pranzo di chi doveva rispondere: un turno da otto
 * secondi di lavoro archiviato come «43m 12s». Non è una misura di lentezza, è
 * una misura di quanto ci ha messo una persona a leggere una notifica.
 *
 * Il registro qui sotto tiene i cronometri delle attese aperte (una per tool che
 * ha chiesto qualcosa) e ne somma i pezzi man mano che si chiudono. Chi chiude
 * il turno sottrae il totale.
 *
 * Perché un oggetto e non due variabili nella chiusura dello stream: così la
 * regola si può provare senza montare un turno intero, ed è una regola con dei
 * bordi (chiusure ripetute, attese ancora aperte a fine turno, orologi che vanno
 * all'indietro) che è meglio avere sotto test.
 */
export interface HumanWaitLedger {
  /** Comincia ad aspettare per questo tool. Ripetuta sullo stesso id, non fa nulla. */
  open(toolCallId: string, at: number): void;
  /** Chiude l'attesa di questo tool e ne somma il pezzo. Su un id sconosciuto, non fa nulla. */
  close(toolCallId: string, at: number): void;
  /** Chiude tutto quello che è rimasto aperto — il turno finisce, l'attesa pure. */
  closeAll(at: number): void;
  /** I millisecondi aspettati finora, solo attese chiuse. */
  totalMs(): number;
  /** C'è almeno un'attesa aperta? */
  isWaiting(): boolean;
}

export function createHumanWaitLedger(): HumanWaitLedger {
  const open = new Map<string, number>();
  let total = 0;
  return {
    open(toolCallId, at) {
      // Non si riapre un'attesa già aperta: farlo perderebbe il suo inizio e
      // conterebbe come lavoro il pezzo già passato.
      if (open.has(toolCallId)) return;
      open.set(toolCallId, at);
    },
    close(toolCallId, at) {
      const started = open.get(toolCallId);
      if (started == null) return;
      open.delete(toolCallId);
      // Un orologio che va all'indietro (ora legale, ntp) non deve produrre un
      // tempo di lavoro più lungo del turno.
      total += Math.max(0, at - started);
    },
    closeAll(at) {
      for (const started of open.values()) total += Math.max(0, at - started);
      open.clear();
    },
    totalMs: () => total,
    isWaiting: () => open.size > 0,
  };
}
