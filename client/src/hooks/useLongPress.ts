/**
 * useLongPress — «tieni premuto» come UNICA definizione del gesto.
 *
 * Su touch non esiste il tasto destro: ogni menu contestuale dell'app deve
 * potersi aprire tenendo premuto. Prima il gesto esisteva in tre copie locali e
 * una era rotta:
 *   · `PaneTabBar` (tab): timer 500ms, funzionante ma a tolleranza ZERO —
 *     `onTouchMove` annullava al primo pixel di tremolio, quindi su un dito
 *     reale spesso non partiva, e senza `touchcancel` restava armato quando il
 *     sistema si prendeva il tocco (una notifica, una gesture di bordo): il
 *     menu si apriva dopo, da solo.
 *   · `MessageBubble`: seconda copia dello stesso timer.
 *   · `BrowserToolbar`: armato su `onMouseDown` e disarmato su `onMouseUp` —
 *     su iOS quei due eventi sono sintetizzati INSIEME al `touchend`, quindi il
 *     timer nasceva e moriva nello stesso tick e la cronologia Indietro/Avanti
 *     era irraggiungibile, nonostante il `title` promettesse «tieni premuto».
 *
 * Qui il gesto è uno solo, e porta con sé le tre cose che le copie non avevano:
 *
 *  1. TOLLERANZA. Il dito non sta fermo: si annulla oltre `slop` px (default 10),
 *     non al primo movimento. Sotto quella soglia il gesto sopravvive.
 *  2. `touchcancel`. Se il sistema si prende il tocco, il timer muore con lui.
 *  3. IL CLIC SUCCESSIVO SI MANGIA. Dopo un long-press andato a segno il browser
 *     sintetizza comunque un `click`: senza `consumeClick()` il menu si apre e
 *     subito dopo la riga si attiva sotto di esso.
 *
 * E due cose che su iPhone contano più del resto:
 *
 *  · FEEDBACK VISIVO. `haptic()` è un no-op su iOS (niente Vibration API), quindi
 *    500ms di attesa sarebbero ciechi: `pressed` sale appena il timer parte e i
 *    chiamanti lo rendono visibile (`data-pressing`, vedi index.css).
 *  · IL TOCCO NON RISALE. A gesto avvenuto il `touchend` viene fermato: la
 *    sidebar mobile chiude su uno swipe di -60px agganciato al CONTENITORE
 *    (`useSidebarAndLayout.handleSidebarTouchEnd`), e un dito che scivola
 *    mentre tiene premuto chiuderebbe la sidebar sotto il menu appena aperto.
 *
 * NB — chi lo monta su un elemento `draggable` deve spegnere il drag su touch
 * (`draggable={!isTouch && …}`, come fa `PaneTabBar`): il lift nativo di HTML5
 * contende lo stesso gesto. E l'elemento vuole `select-none` (o
 * `-webkit-touch-callout: none`) o iOS ci mette sopra il proprio callout.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { haptic } from './useMobile';

/** Quanto tenere premuto prima che il gesto scatti. */
export const LONG_PRESS_MS = 500;
/** Quanto può scivolare il dito senza annullare il gesto. */
export const LONG_PRESS_SLOP_PX = 10;

export interface LongPressOptions {
  /** Off = nessun handler attivo (desktop: lì c'è il tasto destro). Default true. */
  enabled?: boolean;
  /** Millisecondi di pressione. Default {@link LONG_PRESS_MS}. */
  ms?: number;
  /** Tolleranza di movimento in px. Default {@link LONG_PRESS_SLOP_PX}. */
  slopPx?: number;
}

export interface LongPressTarget {
  /** L'elemento su cui è partito il gesto — l'ancora naturale del menu. */
  element: HTMLElement;
  /**
   * The node the finger actually landed on: the innermost target of the
   * `touchstart`, not the element the hook is mounted on. A gesture recogniser
   * that follows dnd-kit's advice — listeners on the target, so a re-render
   * cannot orphan them — is listening HERE, and this is the only address at
   * which it can be told that the press took the finger (`releaseTouchDrag`).
   */
  touched: EventTarget;
  /** Il punto toccato, in coordinate viewport. */
  x: number;
  y: number;
}

export interface LongPressBinding {
  /** Vero fra l'inizio della pressione e la fine del gesto: per il feedback visivo. */
  pressed: boolean;
  /**
   * Da chiamare in cima all'`onClick` dell'elemento. Restituisce `true` se quel
   * clic è l'eco del long-press appena avvenuto e va ignorato (e consuma il flag).
   */
  consumeClick: () => boolean;
  /** Da spandere sull'elemento: `<div {...binding.handlers}>`. */
  handlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
    onTouchCancel: (e: React.TouchEvent) => void;
  };
}

/**
 * Apre, tenendo premuto, LO STESSO menu che il tasto destro apre col mouse.
 *
 * È il compagno naturale di {@link useLongPress}: si passa direttamente come
 * callback e non serve altro —
 *
 *     const lp = useLongPress(openContextMenuAt, { enabled: isTouch });
 *     <div {...lp.handlers} onContextMenu={…} onClick={e => { if (lp.consumeClick()) return; … }}>
 *
 * Il trucco è non duplicare NIENTE: invece di ricostruire su touch un secondo
 * menu con un sottoinsieme delle voci — che è come sono nati i buchi di oggi
 * (la riga chat: 6 voci col tasto destro, 2 col dito; il progetto: 4 contro 1) —
 * si sintetizza l'evento `contextmenu` che quel menu già ascolta. React delega
 * gli handler alla radice, quindi un evento nativo che BOLLE viene raccolto
 * dall'`onContextMenu` di React esattamente come quello del mouse, con le stesse
 * coordinate. Un menu solo, per costruzione: non può divergere perché è lo stesso.
 */
export function openContextMenuAt({ element, x, y }: LongPressTarget): void {
  element.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  }));
}

export function useLongPress(
  onLongPress: (target: LongPressTarget) => void,
  { enabled = true, ms = LONG_PRESS_MS, slopPx = LONG_PRESS_SLOP_PX }: LongPressOptions = {},
): LongPressBinding {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);
  const [pressed, setPressed] = useState(false);

  // Il callback vive in un ref: così i quattro handler restano stabili anche
  // quando il chiamante ricrea la closure a ogni render (il caso normale, visto
  // che di solito cattura l'id della riga).
  const cbRef = useRef(onLongPress);
  useEffect(() => { cbRef.current = onLongPress; }, [onLongPress]);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    originRef.current = null;
    setPressed(false);
  }, []);

  // Un timer armato non deve sopravvivere alla riga che lo ha armato: una tab
  // che si chiude mentre la tieni premuta aprirebbe il menu di un pane morto.
  useEffect(() => clear, [clear]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (!enabled) return;
    // Due dita = pinch/scroll, non una pressione.
    if (e.touches.length !== 1) { clear(); return; }
    const touch = e.touches[0];
    const element = e.currentTarget as HTMLElement;
    const touched = e.target;
    const x = touch.clientX;
    const y = touch.clientY;
    firedRef.current = false;
    originRef.current = { x, y };
    setPressed(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      firedRef.current = true;
      setPressed(false);
      haptic('medium');
      cbRef.current({ element, touched, x, y });
    }, ms);
  }, [enabled, ms, clear]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!timerRef.current || !originRef.current) return;
    const touch = e.touches[0];
    if (!touch) { clear(); return; }
    const dx = touch.clientX - originRef.current.x;
    const dy = touch.clientY - originRef.current.y;
    // Distanza al quadrato: nessuna radice, e la soglia resta esatta.
    if (dx * dx + dy * dy > slopPx * slopPx) clear();
  }, [slopPx, clear]);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    // Il gesto è andato a segno: il tocco è NOSTRO e non risale (vedi lo swipe
    // di chiusura della sidebar mobile, agganciato al contenitore).
    if (firedRef.current) {
      e.stopPropagation();
      e.preventDefault();
    }
    clear();
  }, [clear]);

  const onTouchCancel = useCallback(() => {
    firedRef.current = false;
    clear();
  }, [clear]);

  const consumeClick = useCallback(() => {
    if (!firedRef.current) return false;
    firedRef.current = false;
    return true;
  }, []);

  return {
    pressed,
    consumeClick,
    handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel },
  };
}
