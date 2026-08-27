import { useState, useEffect } from 'react';
import { mediaQuery, mediaQueryMatches } from '../lib/mediaQuery';

/**
 * `isTouch`, `isMobile` e `hasHover` SONO TRE DOMANDE DIVERSE. Qui c'è la
 * risposta unica, perché confonderle ha già fatto danni misurabili.
 *
 *  · `isTouch` — «questo device SI PUÒ toccare» (`ontouchstart` /
 *    `maxTouchPoints`). Serve per AGGIUNGERE affordance al dito: long-press al
 *    posto del tasto destro, bersagli da 44px, drag nativo HTML5 spento (il suo
 *    lift contende lo stesso gesto). Non dice NIENTE sul mouse: un portatile con
 *    schermo touch è `isTouch` e ha anche il puntatore.
 *
 *  · `hasHover` — «esiste un puntatore che può PASSARE SOPRA senza premere»
 *    (`(hover: hover)`). È l'unica domanda che autorizza a NASCONDERE un comando
 *    dietro l'hover: se la risposta è no, quel comando è irraggiungibile. Serve
 *    anche a decidere se armare i gestori MOUSE di un gesto.
 *
 *  · `isMobile` — «lo schermo è piccolo» (<768px, o <1024 se touch). È una
 *    domanda di LAYOUT: quante colonne, sidebar a scomparsa, tab-strip unica.
 *    Non c'entra né col dito né col mouse.
 *
 * Le tre non sono esclusive e vanno usate INSIEME quando servono insieme. Il
 * caso che ha rotto le cose: `isTouch` usato come se significasse «niente
 * hover» ha lasciato la barra azioni dei messaggi permanentemente a opacity-40
 * (MessageBubble) e ha SPENTO i gestori mouse del «tieni premuto» sui bottoni
 * Indietro/Avanti (BrowserToolbar) — su un ibrido la cronologia tornava
 * raggiungibile col solo tasto destro, cioè esattamente il difetto che quel
 * codice diceva di aver chiuso, spostato su un'altra popolazione.
 * Regola: affordance touch → `isTouch`; nascondere dietro l'hover → `hasHover`;
 * quante colonne → `isMobile`.
 */
interface MobileState {
  isMobile: boolean;           // Screen width < 768px
  isTouch: boolean;            // Touch device
  /** Esiste un puntatore che fa hover — `(hover: hover)`. Vedi il blocco sopra. */
  hasHover: boolean;
  isStandalone: boolean;       // PWA installed
  isIOS: boolean;              // iOS device
  isAndroid: boolean;          // Android device
  safeAreaInsets: {            // Safe area for notch/home indicator
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  keyboardVisible: boolean;    // Virtual keyboard open
  orientation: 'portrait' | 'landscape';
}

/** The two queries this hook reads. Constants because they are the memo key
 *  in `lib/mediaQuery`: one list each, for the whole session. */
const HOVER_QUERY = '(hover: hover)';
const STANDALONE_QUERY = '(display-mode: standalone)';

export function useMobile(): MobileState {
  const [state, setState] = useState<MobileState>(() => getInitialState());

  useEffect(() => {
    // Si aggiorna solo se qualcosa e' DAVVERO cambiato.
    //
    // `getInitialState()` restituisce un oggetto nuovo a ogni chiamata, quindi
    // un `setState(getInitialState())` secco ri-renderizzava ogni consumatore a
    // OGNI evento di resize — anche quando nessuno dei valori si era mosso. Da
    // quando questo hook e' letto PER RIGA di sidebar (TopicItem, che prima
    // usava una costante di modulo), quel render passa da uno a N: trascinare
    // il bordo della finestra ridisegnava l'albero intero, `memo` compreso, e
    // ogni riga rifaceva tre `matchMedia` piu' le regex sullo user-agent.
    // Il confronto e' superficiale su tutti i campi tranne `safeAreaInsets`,
    // che e' l'unico annidato e si confronta a mano sui suoi quattro numeri.
    const sameState = (a: MobileState, b: MobileState): boolean =>
      a.isMobile === b.isMobile &&
      a.isTouch === b.isTouch &&
      a.hasHover === b.hasHover &&
      a.isStandalone === b.isStandalone &&
      a.isIOS === b.isIOS &&
      a.isAndroid === b.isAndroid &&
      a.keyboardVisible === b.keyboardVisible &&
      a.orientation === b.orientation &&
      a.safeAreaInsets.top === b.safeAreaInsets.top &&
      a.safeAreaInsets.bottom === b.safeAreaInsets.bottom &&
      a.safeAreaInsets.left === b.safeAreaInsets.left &&
      a.safeAreaInsets.right === b.safeAreaInsets.right;

    const updateState = () => {
      setState((prev) => {
        const next = getInitialState();
        return sameState(prev, next) ? prev : next;
      });
    };

    // Listen for resize
    window.addEventListener('resize', updateState);
    window.addEventListener('orientationchange', updateState);

    // `hasHover` non cambia con la finestra: cambia quando cambia il PUNTATORE
    // (un mouse collegato a un tablet, la Magic Keyboard tolta da un iPad, la
    // finestra spostata su un altro schermo). Nessun `resize` accompagna quegli
    // eventi, quindi senza questo listener il valore resterebbe fermo a quello
    // del montaggio — e i comandi nascosti dietro l'hover resterebbero nascosti
    // (o scoperti) fino al remount.
    const hoverMq = mediaQuery(HOVER_QUERY);
    // `addListener` è il fallback per i WebKit < 14: lì `addEventListener` sulla
    // MediaQueryList non esiste, e senza il ramo vecchio il listener non si
    // aggancia affatto invece di degradare.
    if (hoverMq?.addEventListener) hoverMq.addEventListener('change', updateState);
    else hoverMq?.addListener?.(updateState);

    // Listen for keyboard (iOS/Android). Capture the handler so cleanup can
    // remove it — an inline listener here leaked one visualViewport listener per
    // mount (useMobile is called from Menu/PaneAddMenu, mounted on every open).
    const vv = 'visualViewport' in window ? window.visualViewport : null;
    const onViewportResize = vv
      ? () => {
          const keyboardVisible = vv.height < window.innerHeight * 0.75;
          setState(prev => ({ ...prev, keyboardVisible }));
        }
      : null;
    if (vv && onViewportResize) vv.addEventListener('resize', onViewportResize);

    return () => {
      window.removeEventListener('resize', updateState);
      window.removeEventListener('orientationchange', updateState);
      if (hoverMq?.removeEventListener) hoverMq.removeEventListener('change', updateState);
      else hoverMq?.removeListener?.(updateState);
      if (vv && onViewportResize) vv.removeEventListener('resize', onViewportResize);
    };
  }, []);

  return state;
}

function getInitialState(): MobileState {
  if (typeof window === 'undefined') {
    return {
      isMobile: false,
      isTouch: false,
      // Fuori dal browser (SSR / test) si assume il puntatore: è il default che
      // NON nasconde niente a nessuno — un comando visibile di troppo si vede,
      // uno nascosto per errore non si raggiunge.
      hasHover: true,
      isStandalone: false,
      isIOS: false,
      isAndroid: false,
      safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      keyboardVisible: false,
      orientation: 'portrait',
    };
  }

  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  // Domanda ORTOGONALE a `isTouch`, non il suo contrario: su un portatile con
  // schermo touch sono vere entrambe. Se `matchMedia` non c'è si assume di sì,
  // per lo stesso motivo del ramo SSR qui sopra.
  const hasHover = typeof window.matchMedia === 'function'
    ? mediaQueryMatches(HOVER_QUERY)
    : true;
  const isMobile = window.innerWidth < 768 || (isTouch && window.innerWidth < 1024);
  const isStandalone = mediaQueryMatches(STANDALONE_QUERY) ||
    // `navigator.standalone` is a non-standard iOS Safari flag (PWA installed to home screen).
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

  // Get safe area insets from CSS env()
  const computedStyle = getComputedStyle(document.documentElement);
  const safeAreaInsets = {
    top: parseInt(computedStyle.getPropertyValue('--sat') || '0') || 0,
    bottom: parseInt(computedStyle.getPropertyValue('--sab') || '0') || 0,
    left: parseInt(computedStyle.getPropertyValue('--sal') || '0') || 0,
    right: parseInt(computedStyle.getPropertyValue('--sar') || '0') || 0,
  };

  const orientation = window.innerHeight > window.innerWidth ? 'portrait' : 'landscape';

  return {
    isMobile,
    isTouch,
    hasHover,
    isStandalone,
    isIOS,
    isAndroid,
    safeAreaInsets,
    keyboardVisible: false,
    orientation,
  };
}

/**
 * La micro-vibrazione vive in `lib/haptics.ts`, non più qui: non è uno stato del
 * dispositivo da leggere a ogni render come le cinque risposte di sopra, è una
 * capacità della PIATTAFORMA con una storia lunga da raccontare (la Vibration
 * API che su iOS non è mai esistita, e il trucco dello switch che Apple ha
 * chiuso in iOS 26.5). Quella storia sta scritta là dentro, dove la trova chi
 * apre il file cercando «perché su iPhone non vibra».
 *
 * Il ri-esporto resta perché il punto di ingresso non deve cambiare: il gesto la
 * importa da `useMobile` da sempre.
 */
export { haptic } from '../lib/haptics';

