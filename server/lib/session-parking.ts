/**
 * Parcheggiare la sessione Claude di un topic — una porta sola.
 *
 * PERCHÉ ESISTE. Una fase come `awaiting-user` non si spegne da sola, ed è una
 * scelta: «tocca a te» deve durare quanto stai via. Ma un topic ARCHIVIATO non
 * ha più né riga né tab, quindi non esiste più nessun gesto umano che possa
 * spegnerla — e i due reconcile di boot (`busy-reconcile`, `orphan-transcript`
 * in server.ts) filtrano `archived = 0`, cioè la saltano apposta. La fase resta
 * viva per sempre.
 *
 * Misurato il 2026-08-09: 28 sessioni di chat archiviate ancora VIVE nello
 * snapshot del server — 20 ferme su `awaiting-user`, ultima attività a metà
 * luglio, tutte con `updated_at` al 03/08 (una archiviazione di progetto in
 * blocco). Erano ri-servite a ogni bootstrap del client dentro le 206 sessioni
 * di `/api/claude-sessions` e ri-tailate a ogni sweep, pronte a produrre un
 * banner col nome di una chat chiusa da settimane.
 *
 * PERCHÉ UNA PORTA E NON UN PARAMETRO. Archiviare si fa in più punti — il
 * servizio condiviso (`services/archive-topic.ts`), il dispatcher che pota i
 * topic dei tentativi, e `POST /api/topics/bulk-archive`, che è una QUARTA
 * implementazione con le sue scritture. È quest'ultima che ha prodotto la
 * perdita. Una funzione importabile da tutti e tre vuol dire che un quinto
 * percorso, domani, non può dimenticarsene in silenzio: o la chiama, o si vede.
 *
 * `dormant` e non un cancello duro: è a riposo (niente banner, niente spinner)
 * e resta RISVEGLIABILE — se il topic viene disarchiviato, il primo hook o la
 * prima riga di transcript lo rianima da sé. Non tocca nessun processo.
 */

/** Iniettata da server.ts appena il tracker esiste (nasce dopo il contesto). */
let parkBySessionKey: ((sessionKey: string) => void) | null = null;

function configureSessionParking(fn: (sessionKey: string) => void): void {
  parkBySessionKey = fn;
}

/** Il pezzo di tracker che serve al parcheggio, e nient'altro. */
interface ParkableTracker {
  getSessionByKey(sessionKey: string): { claudeSessionId: string } | null;
  noteDormant(claudeSessionId: string): boolean;
}

/**
 * Il collegamento vero fra la porta e il tracker: `sessionKey` → sessione →
 * `dormant`. Sta QUI e non inline in server.ts perché è l'anello che un test
 * d'integrazione deve poter montare identico a produzione — se la traduzione
 * chiave→sessione vive dentro server.ts, il test ne monta una COPIA e la
 * regressione può tornare proprio lì (l'unico posto non coperto). Chiamata una
 * volta al boot, subito dopo che il tracker esiste.
 */
export function configureSessionParkingForTracker(tracker: ParkableTracker): void {
  configureSessionParking((sessionKey) => {
    const st = tracker.getSessionByKey(sessionKey);
    if (st?.claudeSessionId) tracker.noteDormant(st.claudeSessionId);
  });
}

/**
 * Porta la sessione Claude di questo `sessionKey` a `dormant`, se ne ha una in
 * una fase viva. No-op quando il parcheggio non è configurato (test, bundle
 * standalone), quando il sessionKey manca, e — dentro il tracker — quando la
 * fase è già dormant o terminale: il ripasso di un archivio già fatto non costa
 * né scritture né broadcast. Non lancia mai: archiviare non deve poter fallire
 * per colpa di una fase.
 */
export function parkTopicSession(sessionKey: string | null | undefined): void {
  if (!sessionKey || !parkBySessionKey) return;
  try {
    parkBySessionKey(sessionKey);
  } catch (err) {
    console.warn(`[session-parking] park di ${sessionKey} fallito:`, (err as Error)?.message ?? err);
  }
}
