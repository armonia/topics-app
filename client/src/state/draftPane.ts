/**
 * «Aperta ma non aperta»: il ciclo di vita di una chat NUOVA.
 *
 * Una bozza (`draft:<uuid>`) non è una tab come le altre. È un foglio bianco
 * che l'app tira fuori quando chiedi una chat nuova, e finché resta bianco non
 * possiede niente: nessun topic sul server, nessun messaggio, nessuna storia.
 * Trattarla come una tab normale produceva due difetti gemelli, tutti e due
 * segnalati:
 *
 *   • se ne potevano accumulare N vuote, una per ogni volta che chiedevi una
 *     chat nuova — tab identiche, indistinguibili, nessuna delle quali era
 *     «quella giusta»;
 *   • aprivi la chat nuova, cambiavi idea e tornavi su una tab esistente, e il
 *     foglio bianco restava lì per sempre.
 *
 * La regola, adesso: una bozza VUOTA è al massimo una, e vive finché la
 * guardi. Appena ci scrivi dentro smette di essere vuota e diventa tua — da
 * quel momento non se ne va più da sola.
 *
 * «Vuota» = niente testo, niente allegati in attesa. È la stessa domanda che
 * il composer si fa per decidere se il tasto Invia è acceso, e qui deve dare
 * la stessa risposta: il registro sotto lo tiene aggiornato ChatPane, che è
 * l'unico a sapere degli allegati (file e immagini incollate vivono in memoria,
 * non su localStorage — chiudere una bozza che ne ha uno vorrebbe dire
 * buttarlo).
 */

/** La chiave con cui ChatPane conserva il testo non spedito di una pane. */
export function draftTextKey(paneId: string): string {
  return `draft:${paneId}`;
}

/**
 * Bozze che in questo momento hanno qualcosa dentro. La popola ChatPane; una
 * pane assente dal registro è una che non è mai stata disegnata in questa
 * sessione (riaperta all'avvio), e per quella si ripiega sul testo salvato.
 */
const dirtyDrafts = new Map<string, boolean>();

export function setDraftDirty(paneId: string, dirty: boolean): void {
  dirtyDrafts.set(paneId, dirty);
}

export function forgetDraft(paneId: string): void {
  dirtyDrafts.delete(paneId);
}

/** C'è qualcosa da perdere in questa bozza? */
export function isDraftPaneEmpty(paneId: string): boolean {
  const known = dirtyDrafts.get(paneId);
  if (known !== undefined) return !known;
  try {
    return (localStorage.getItem(draftTextKey(paneId)) ?? '').trim().length === 0;
  } catch {
    // Storage negato (Safari in privata, iframe di terze parti): meglio
    // rispondere «non è vuota» e tenersi una tab in più che chiuderne una con
    // dentro il lavoro di qualcuno.
    return false;
  }
}

/**
 * La bozza vuota già aperta, se c'è. Chiedere una chat nuova quando ne esiste
 * già una bianca non ne apre una seconda: riporta il fuoco su quella.
 */
export function findEmptyDraftPane(paneIds: readonly string[]): string | null {
  for (const id of paneIds) {
    if (!id.startsWith('draft:')) continue;
    if (isDraftPaneEmpty(id)) return id;
  }
  return null;
}
