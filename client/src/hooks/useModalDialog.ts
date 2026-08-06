import { useEffect, useRef } from 'react';
import { closeAllPopovers } from '../lib/popoverRegistry';

/**
 * useModalDialog — UN contratto per i modali a schermo intero, come
 * `useDismissable` lo è per menu e popover. Tre cose che ogni dialogo dovrebbe
 * avere e che quasi nessuno aveva:
 *
 *   1. **Escape chiude.** Impostazioni, roster agenti, editor di profilo e
 *      pannello di assegnazione si chiudevano SOLO con la X: nessuno ascoltava
 *      Escape, e in tre casi su quattro nemmeno il click sul velo funzionava.
 *   2. **Il tasto Tab resta dentro.** Senza trappola, Tab esce dal dialogo e va
 *      a passeggiare sulla pagina sotto — che è coperta e non si vede: da
 *      tastiera il focus sparisce e non si sa più dove si è.
 *   3. **Il focus torna da dove è partito.** Alla chiusura il focus rientra
 *      sull'elemento che aveva aperto il dialogo, non sul `<body>`.
 *
 * **Annidamento.** I dialoghi si annidano (il roster apre l'editor di profilo):
 * se ogni istanza rispondesse a Escape, un solo tasto li chiuderebbe tutti. C'è
 * quindi una pila a livello di modulo — risponde SOLO quello in cima, esattamente
 * come si aspetta chi preme Escape.
 *
 * Escape viene ascoltato in capture su `window` e ferma la propagazione: il
 * gestore globale delle scorciatoie è registrato prima (in capture, sempre su
 * `window`), quindi un `stopPropagation` dal DOM del dialogo arriverebbe tardi.
 * Il ramo "interrompi il turno dell'AI" di `useKeyboardShortcuts` è comunque
 * protetto a monte da `hasOpenModalSurface()` — questa è la seconda cintura,
 * quella che fa CHIUDERE il dialogo invece di limitarsi a non fare danni.
 */

/** Pila dei dialoghi aperti: l'ultimo è quello in cima. */
const stack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0 && el.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Dove mandare il focus quando si preme Tab dentro un dialogo.
 *
 * `null` = non intervenire, ci pensa il browser (il focus resta comunque dentro
 * la card). Si interviene solo ai due bordi — e quando il focus è FUORI dagli
 * elementi della card (`active === null`), che è il caso del focus iniziale
 * appoggiato sulla card stessa: da lì il Tab deve ENTRARE, non uscire.
 *
 * Generico e senza DOM apposta: è la regola, e la regola si testa da sola.
 */
export function nextTrapFocus<T>(items: readonly T[], active: T | null, shiftKey: boolean): T | null {
  if (items.length === 0) return null;
  const first = items[0];
  const last = items[items.length - 1];
  if (active === null) return shiftKey ? last : first;
  if (shiftKey && active === first) return last;
  if (!shiftKey && active === last) return first;
  return null;
}

export interface UseModalDialogOptions {
  /** false = dialogo smontato/chiuso: nessun listener, nessuna voce nella pila. */
  open?: boolean;
  onClose: () => void;
  /** La CARD del dialogo (non il velo): confine della trappola del focus. */
  panelRef: React.RefObject<HTMLElement | null>;
  /** Dove mandare il focus all'apertura. Default: il primo elemento
   *  focalizzabile della card, o la card stessa. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Chiudere su Escape (default true). */
  closeOnEscape?: boolean;
}

export function useModalDialog({
  open = true,
  onClose,
  panelRef,
  initialFocusRef,
  closeOnEscape = true,
}: UseModalDialogOptions): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  // Identità di QUESTA istanza nella pila: stabile per tutta la vita del hook.
  const idRef = useRef<symbol | null>(null);
  idRef.current ??= Symbol('modal');

  useEffect(() => {
    if (!open) return;
    const id = idRef.current!;
    stack.push(id);

    // Un modale sgombera i popover. Non è cosmesi: i due sistemi sono separati
    // (`useDismissable` per i menu, questa pila per i dialoghi), quindi un
    // dropdown aperto sopravviveva a ⌘K e restava a schermo SOPRA il velo —
    // orfano, senza più il contesto che lo aveva prodotto.
    closeAllPopovers();

    const restoreTo = document.activeElement as HTMLElement | null;
    // Il nodo della card COM'ERA all'apertura: alla pulizia il ref può essere
    // già stato azzerato da React, e senza questa copia il controllo "il focus
    // è ancora dentro?" direbbe sempre di no.
    const panelAtOpen = panelRef.current;

    // Focus iniziale: senza, la tastiera parte dal `<body>` e il primo Tab
    // finisce nella pagina sotto invece che nel dialogo.
    const target =
      initialFocusRef?.current ??
      (panelRef.current ? focusableWithin(panelRef.current)[0] ?? panelRef.current : null);
    if (target) {
      // La card non è focalizzabile di suo: rendila tale per il tempo che serve
      // (tabIndex -1 = raggiungibile via focus(), non via Tab).
      if (target === panelRef.current && !target.hasAttribute('tabindex')) target.tabIndex = -1;
      target.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      // Solo il dialogo in cima risponde: altrimenti Escape ne chiuderebbe due.
      if (stack[stack.length - 1] !== id) return;

      if (closeOnEscape && e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onCloseRef.current();
        return;
      }

      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = focusableWithin(panel);
      if (items.length === 0) {
        // Nessun elemento focalizzabile: il Tab non deve comunque uscire.
        e.preventDefault();
        return;
      }
      const raw = document.activeElement as HTMLElement | null;
      // La card stessa (tabIndex -1, focus iniziale) conta come "fuori": da lì
      // il Tab deve entrare nel primo elemento, non uscire dal dialogo.
      const active = raw && raw !== panel && panel.contains(raw) ? raw : null;
      const target = nextTrapFocus(items, active, e.shiftKey);
      if (target) { e.preventDefault(); target.focus(); }
    };

    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const i = stack.lastIndexOf(id);
      if (i !== -1) stack.splice(i, 1);
      // Restituisci il focus solo se è ancora dentro il dialogo (o in nessun
      // posto): se l'utente l'ha già spostato altrove, non glielo si strappa.
      const active = document.activeElement as HTMLElement | null;
      const stillInside = !active || active === document.body || !!panelAtOpen?.contains(active);
      if (stillInside && restoreTo?.isConnected) restoreTo.focus();
    };
    // `initialFocusRef`/`panelRef` sono ref stabili; `onClose` passa dal mirror.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, closeOnEscape]);
}
