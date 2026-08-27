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
 * ── La prima risposta era LASCIAR PASSARE, e non bastava ────────────────────
 * All'inizio, se sotto il dito c'era un comando, il tocco passava e il gesto di
 * sistema restava possibile su quel pixel. Attilio, 12/08: «facendo swipe da PWA
 * fa indietro sulla history del browser». Il buco è proprio quello, e col
 * cassetto APERTO è largo quanto tutto lo schermo: il cassetto mobile è largo
 * 100vw ed è fatto di righe, cioè di `<button>`. Ogni swipe per chiuderlo
 * partiva sopra un comando, quindi ogni swipe per chiuderlo era autorizzato a
 * essere un «indietro». La regola «i comandi passano» non stava proteggendo un
 * caso raro: stava spegnendo la guardia nel caso normale.
 *
 * ── Cosa fa adesso: blocca sempre, e RIMETTE il clic ────────────────────────
 * Sul bordo il gesto è sempre nostro. Il clic che `preventDefault` porta via lo
 * si ridà a mano: se il dito si stacca dov'era (entro 10px) e in fretta (700ms),
 * quello era un TOCCO, e il tocco viene rimesso in scena — `focus()` per i campi
 * di testo, che il clic sintetico da solo non risveglia, e poi un `click` vero
 * sull'elemento. Se invece il dito ha viaggiato, era uno swipe: nessun clic, ed
 * è esattamente ciò che si voleva.
 *
 * Due eccezioni restano fuori dal blocco, perché per loro un clic sintetico non
 * è il clic: `<select>` e `<input type="file">` aprono un'interfaccia di SISTEMA
 * che solo un tocco vero apre. Lì si preferisce un gesto di navigazione in più a
 * un comando che non fa niente.
 *
 * `elementFromPoint` costa una lettura di layout per tocco, e solo per i tocchi
 * che nascono sul bordo.
 */
import { mediaQueryMatches } from './mediaQuery';

/** Quanto è larga la striscia che iOS considera «bordo». 24px è la misura che
 *  copre il gesto senza mangiarsi mezza colonna. */
const EDGE_PX = 24;

/** Ciò che un dito può voler PREMERE: il tocco si blocca lo stesso, ma il clic
 *  gli viene rimesso in scena se il dito non è andato da nessuna parte. */
const INTERACTIVE = 'button, a, input, textarea, select, label, [role="button"], [role="menuitem"], [contenteditable="true"]';

/** I comandi che aprono un'interfaccia di SISTEMA: un clic sintetico non la
 *  apre, quindi su questi non si blocca niente. */
const DI_SISTEMA = 'select, input[type="file"]';

/** Un campo di testo va anche MESSO A FUOCO: `preventDefault` sul `touchstart`
 *  toglie al browser anche quello, e senza fuoco non sale la tastiera. */
const DA_METTERE_A_FUOCO = 'input, textarea, [contenteditable="true"]';

/** Quanto può muoversi il dito e restare un tocco. */
const TOCCO_SLOP_PX = 10;
/** E quanto può durare. Oltre, è una pressione lunga: quella ha già i suoi
 *  gestori e non va raddoppiata con un clic. */
const TOCCO_MS = 700;

/** Solo dove il gesto esiste davvero: iPhone/iPad, e solo in standalone. Nel
 *  browser normale la barra di Safari è lì a vista e il gesto è quello che
 *  l'utente si aspetta; nella PWA non c'è nessuna barra da cui tornare. */
function shouldGuard(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  if (!/iPhone|iPad|iPod/.test(navigator.userAgent)) return false;
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    mediaQueryMatches('(display-mode: standalone)');
  return standalone;
}

/**
 * Il clic che `preventDefault` ha portato via, rimesso in scena — ma solo se
 * quel tocco era davvero un tocco.
 *
 * I listener si montano UNO PER GESTO e si smontano da soli: un `once` sul
 * `touchend` non basterebbe, perché serve anche sapere se nel frattempo il dito
 * è scappato.
 */
function armaIlTocco(comando: Element, x0: number, y0: number): void {
  const nato = Date.now();
  let fuggito = false;

  const move = (e: TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - x0;
    const dy = t.clientY - y0;
    if (dx * dx + dy * dy > TOCCO_SLOP_PX * TOCCO_SLOP_PX) fuggito = true;
  };
  const smonta = () => {
    document.removeEventListener('touchmove', move, true);
    document.removeEventListener('touchend', end, true);
    document.removeEventListener('touchcancel', smonta, true);
  };
  const end = (e: TouchEvent) => {
    smonta();
    if (fuggito || Date.now() - nato > TOCCO_MS) return;
    const t = e.changedTouches[0];
    if (!t) return;
    // Il campo va messo a fuoco a mano: siamo dentro un `touchend`, cioè dentro
    // un gesto dell'utente, che è l'unica finestra in cui iOS alza la tastiera.
    if (comando.matches(DA_METTERE_A_FUOCO)) (comando as HTMLElement).focus?.();
    comando.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: t.clientX,
      clientY: t.clientY,
    }));
  };

  document.addEventListener('touchmove', move, { passive: true, capture: true });
  document.addEventListener('touchend', end, true);
  document.addEventListener('touchcancel', smonta, true);
}

/**
 * La decisione, isolata dagli eventi perché sia interrogabile: dato un punto e
 * cosa c'è sotto, questo tocco lo blocchiamo? E se sì, c'è un clic da rimettere?
 */
export function edgeSwipeVerdict(
  clientX: number,
  larghezza: number,
  sotto: Element | null,
): { blocca: boolean; comando: Element | null } {
  const sulBordo = clientX <= EDGE_PX || clientX >= larghezza - EDGE_PX;
  if (!sulBordo) return { blocca: false, comando: null };
  if (sotto?.closest(DI_SISTEMA)) return { blocca: false, comando: null };
  return { blocca: true, comando: sotto?.closest(INTERACTIVE) ?? null };
}

export function initEdgeSwipeGuard(): () => void {
  if (!shouldGuard()) return () => {};

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const sotto = document.elementFromPoint(t.clientX, t.clientY);
    const { blocca, comando } = edgeSwipeVerdict(t.clientX, window.innerWidth, sotto);
    if (!blocca) return;
    e.preventDefault();
    if (comando) armaIlTocco(comando, t.clientX, t.clientY);
  };

  document.addEventListener('touchstart', onTouchStart, { passive: false, capture: true });
  return () => document.removeEventListener('touchstart', onTouchStart, true);
}
