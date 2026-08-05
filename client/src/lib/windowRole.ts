// Il RUOLO della finestra corrente. Nessun import: è un modulo foglia, così può
// leggerlo anche un modulo puro di `lib/` senza tirarsi dietro mezza app.
//
// ── Perché serve una risposta sola ──────────────────────────────────────────
// Una finestra STACCATA è una pop-out di una o più chat, e la sua identità È la
// query `?topics=<id,…>` (forma storica singolare: `?topic=<id>`). Non è un
// dettaglio cosmetico: `state/pane/bootstrap.ts` ci si basa per SPEGNERE lì
// dentro tutta la persistenza del pane-store — niente snapshot locale, niente
// PUT verso il server, niente canale cross-tab. Tutto ciò che una staccata
// scrive nel pane-store muore alla chiusura, senza aver mai lasciato traccia.
//
// La domanda era duplicata in tre posti, e le copie erano DIVERSE:
// `bootstrap.ts` e `App.tsx` leggono `topics ?? topic`, mentre
// `components/Layout/spaceHelpers.isDetachedWindow` leggeva solo `topic` — cioè
// una pop-out moderna (`?topics=`) risultava NON staccata a chi lo chiedeva a
// quella. Qui la risposta è una, e chi la vuole la importa.

/** I nomi di query che identificano una pop-out: `topics` è la forma corrente
 *  (multi-chat), `topic` quella storica — le finestre già aperte la portano
 *  ancora, quindi vanno riconosciute entrambe. */
const DETACHED_PARAMS = ['topics', 'topic'] as const;

/**
 * `true` se QUESTA finestra è una pop-out staccata.
 *
 * Chi la chiama sta per fare qualcosa che in una staccata non ha senso o fa
 * danno: registrare una pane (nessuno la persiste), mostrare lo switcher degli
 * Spazi, instradare un deep-link (App.tsx si rifiuta già di farlo). Nel dubbio
 * — niente `window`, accesso negato — la risposta è `false`: la finestra
 * normale è il caso comune, e sbagliare in quella direzione al massimo ripete
 * ciò che l'app faceva già.
 */
export function isDetachedWindow(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return DETACHED_PARAMS.some((name) => {
      const value = params.get(name);
      return !!value && value.trim().length > 0;
    });
  } catch {
    return false;
  }
}

/**
 * Lo SPAZIO (gruppo) a cui questa finestra è inchiodata, o `null`.
 *
 * `?space=<id>` è il terzo ruolo, e non è una pop-out: una finestra-gruppo è
 * l'app INTERA con tutti i bridge accesi (apre e chiude tab, le persiste, le
 * sincronizza), solo che disegna un gruppo solo e non ne può cambiare. È la
 * ragione per cui non basta `isDetachedWindow()`: quella spegne la persistenza,
 * e qui spegnerla vorrebbe dire perdere ogni tab aperta in quella finestra.
 *
 * Ciò che cambia rispetto a una finestra normale è tutto qui:
 *   - `activeSpaceId` lo decide la query, non l'ultima scelta locale;
 *   - lo `activeSpaceId` non si scrive in localStorage — è per-finestra, e
 *     quella chiave è condivisa fra le finestre della stessa origine.
 *
 * La sidebar invece mostra TUTTI i gruppi anche qui: una finestra che non sa
 * dire cosa c'è nelle altre è una finestra cieca. Il gruppo che disegna può
 * anche cambiare — vedi `repinSpaceWindow`.
 */
export function spaceWindowId(): string | null {
  try {
    const value = new URLSearchParams(window.location.search).get('space');
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Cambia il gruppo che questa finestra-gruppo disegna.
 *
 * L'inchiodatura vive nella QUERY, non in una variabile: al boot la legge
 * `spaceWindowId()`, e un effetto la ri-afferma quando la registry arriva
 * (`usePanelLifecycle`). Cambiare solo `activeSpaceId` verrebbe quindi disfatto
 * al primo hydrate — l'unico modo onesto di spostare una finestra su un altro
 * gruppo è riscrivere la query, che è la sua identità.
 *
 * `replaceState` e non `push`: non è una tappa di navigazione, è la stessa
 * finestra che cambia contenuto.
 */
export function repinSpaceWindow(spaceId: string): void {
  try {
    const u = new URL(window.location.href);
    u.searchParams.set('space', spaceId);
    window.history.replaceState(null, '', u.toString());
  } catch {
    /* history non disponibile: resta il SET_ACTIVE_SPACE del chiamante */
  }
}
