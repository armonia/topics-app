/**
 * LO SWIPE DAL BORDO NON NAVIGA PIÙ — solo nella PWA su iPhone.
 *
 * Attilio, 07/08: «disabilitiamo lo swipe per fare indietro sul browser, se no
 * fa fastidio».
 *
 * ── Perché dà fastidio ──────────────────────────────────────────────────────
 * In standalone iOS tiene attivo il gesto di navigazione avanti/indietro sui
 * due bordi verticali. Su questa app quel gesto CONTENDE il posto a due cose
 * vere: il bordo sinistro è il gesto che apre il cassetto (`handleEdgeTouchStart`,
 * `clientX < 30`), e la cronologia su cui salta è quella dei permalink dei task
 * (`openTaskLink` fa `pushState`), cioè ti sposta su un altro task mentre
 * pensavi di aprire la sidebar.
 *
 * ── Perché NON si risolve con la cronologia ─────────────────────────────────
 * Il rimedio che si trova ovunque è tenere una voce sentinella e rimetterla a
 * ogni `popstate`. Qui non va: la cronologia di questa app è VERA — i permalink
 * dei task ci scrivono e `openTaskLink` legge il pathname come sorgente di
 * verità — quindi neutralizzarla romperebbe il tasto indietro invece del gesto.
 *
 * ── Cosa fa invece ──────────────────────────────────────────────────────────
 * Annulla l'azione di DEFAULT del tocco quando comincia nei 24px di bordo. È
 * l'unico modo di fermare il gesto: iOS lo decide subito, e `touchstart` è
 * l'ultimo momento in cui si può dire di no. Serve un listener NON passivo (da
 * React 17 quelli del root sono passivi, e lì `preventDefault` è un no-op) e in
 * CATTURA, per arrivare prima di chiunque altro.
 *
 * ── E il prezzo, che è pagato per intero ────────────────────────────────────
 * `preventDefault` su `touchstart` toglie al browser TUTTO il seguito: niente
 * scorrimento nato lì, e niente clic sintetizzato. Su una striscia larga 24px
 * ci vivono dei comandi veri — il «+» della barra delle tab sta a `pr-1` dal
 * bordo destro, il chevron di un progetto a 14px da quello sinistro — e
 * spegnerli sarebbe un difetto peggiore di quello che si sta togliendo.
 *
 * Quindi si guarda COSA c'è sotto il dito: se è un comando (o sta dentro uno),
 * il tocco passa e il gesto di sistema resta possibile su quel pixel; se è
 * superficie inerte, si blocca. `elementFromPoint` costa una lettura di layout
 * per tocco, e solo per i tocchi che nascono sul bordo.
 */

/** Quanto è larga la striscia che iOS considera «bordo». 24px è la misura che
 *  copre il gesto senza mangiarsi mezza colonna. */
const EDGE_PX = 24;

/** Ciò che un dito può voler PREMERE, e che quindi non si blocca mai. */
const INTERACTIVE = 'button, a, input, textarea, select, label, [role="button"], [role="menuitem"], [contenteditable="true"]';

/** Solo dove il gesto esiste davvero: iPhone/iPad, e solo in standalone. Nel
 *  browser normale la barra di Safari è lì a vista e il gesto è quello che
 *  l'utente si aspetta; nella PWA non c'è nessuna barra da cui tornare. */
function shouldGuard(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  if (!/iPhone|iPad|iPod/.test(navigator.userAgent)) return false;
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
  return standalone;
}

export function initEdgeSwipeGuard(): () => void {
  if (!shouldGuard()) return () => {};

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const daSinistra = t.clientX <= EDGE_PX;
    const daDestra = t.clientX >= window.innerWidth - EDGE_PX;
    if (!daSinistra && !daDestra) return;
    // Un comando sotto il dito vince sempre: meglio un gesto di sistema in più
    // che un bottone che non risponde.
    const sotto = document.elementFromPoint(t.clientX, t.clientY);
    if (sotto && (sotto as Element).closest(INTERACTIVE)) return;
    e.preventDefault();
  };

  document.addEventListener('touchstart', onTouchStart, { passive: false, capture: true });
  return () => document.removeEventListener('touchstart', onTouchStart, true);
}
