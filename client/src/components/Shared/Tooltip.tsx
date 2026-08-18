import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * IL TOOLTIP DELL'APP. Nessun `title=` nativo dove l'informazione conta.
 *
 * Il nativo non è «uguale ma brutto», fa tre cose che qui non vanno bene:
 * arriva dopo un ritardo del sistema operativo che non si può regolare (su
 * macOS oltre un secondo, e chi passa sopra un filtro ha già mollato), lo
 * disegna il sistema quindi non conosce i colori dell'app, e non tiene più di
 * una riga di testo: niente titolo + dettaglio, niente percorso in monospazio.
 * Segnalato: «il tooltip con un componente non dovrebbe mai usare cose native,
 * ma solo componenti ben disegnate».
 *
 * Non usa una libreria: serve un rettangolo posizionato, e `@floating-ui` sono
 * 12 kB per un `getBoundingClientRect` e due `Math.min`.
 */

/** Quanto aspetta prima di comparire. Abbastanza da non lampeggiare mentre il
 *  mouse attraversa la fila di filtri, poco da non farsi aspettare. */
const APERTURA_MS = 350;
/** Quanto resta dopo che il mouse esce: zero fa sparire il tooltip mentre ci
 *  stai entrando sopra per leggerlo con calma. */
const CHIUSURA_MS = 120;
/** Distanza dal bordo dell'elemento e dal bordo della finestra. */
const STACCO = 6;
const MARGINE_FINESTRA = 8;

export interface TooltipProps {
  /** Il contenuto. Una stringa per il caso semplice, JSX quando serve una
   *  struttura (titolo + percorso + conteggi). */
  content: ReactNode;
  /** L'elemento che lo attiva. Riceve gli handler, quindi dev'essere uno solo. */
  children: ReactNode;
  /** Sopra invece che sotto, quando sotto non c'è spazio per natura (una barra
   *  a fondo pagina). Il ribaltamento automatico resta comunque attivo. */
  side?: 'top' | 'bottom';
  /** Spegne il tooltip senza smontare il figlio: per i casi in cui il
   *  contenuto non c'è (nessun dettaglio da dare) e un rettangolo vuoto
   *  sarebbe peggio del silenzio. */
  disabled?: boolean;
}

export function Tooltip({ content, children, side = 'bottom', disabled = false }: TooltipProps) {
  const [aperto, setAperto] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const stopTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const apri = () => {
    if (disabled || !content) return;
    stopTimer();
    timer.current = setTimeout(() => {
      // La posizione si azzera QUI, nel gestore, non nell'effetto: e' un
      // evento, non un render, quindi nessuna cascata. Senza, alla riapertura
      // il primo fotogramma userebbe la posizione dell'apertura precedente.
      setPos(null);
      setAperto(true);
    }, APERTURA_MS);
  };
  const chiudi = () => { stopTimer(); timer.current = setTimeout(() => setAperto(false), CHIUSURA_MS); };

  // Smontando col timer in volo, `setAperto` scriverebbe su un componente che
  // non c'è più. Succede davvero: i filtri si rimontano quando cambia la board.
  useEffect(() => stopTimer, []);

  // ESC lo chiude. Chi naviga da tastiera deve poterselo togliere di mezzo
  // senza spostare il fuoco.
  useEffect(() => {
    if (!aperto) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { stopTimer(); setAperto(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [aperto]);

  // La posizione si calcola DOPO il montaggio, quando il rettangolo del
  // tooltip ha una dimensione vera: prima si può solo indovinare, e un
  // tooltip largo indovinato stretto esce dallo schermo.
  useLayoutEffect(() => {
    // NIENTE `setPos(null)` ALLA CHIUSURA: sarebbe una scrittura di stato
    // sincrona dentro un effetto (il lint la vieta, e ha ragione - innesca un
    // secondo render a cascata su un componente che sta sparendo). Non serve:
    // il tooltip smontato porta via il suo rettangolo, e alla riapertura il
    // ramo qui sotto ricalcola prima che qualcuno lo veda. La posizione vecchia
    // non si rivede perche' `visibility` resta `hidden` finche' `pos` non e'
    // stato riscritto DA QUESTA apertura - vedi lo `style` in fondo.
    if (!aperto) return;
    const anchor = wrapRef.current?.firstElementChild ?? wrapRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const a = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const sotto = a.bottom + STACCO;
    const sopra = a.top - t.height - STACCO;
    // Si ribalta solo se dalla parte scelta NON ci sta. Ribaltare sempre in
    // base a «metà schermo» fa saltare il tooltip mentre scorri.
    let top = side === 'bottom' ? sotto : sopra;
    if (side === 'bottom' && sotto + t.height > window.innerHeight - MARGINE_FINESTRA && sopra >= MARGINE_FINESTRA) top = sopra;
    if (side === 'top' && sopra < MARGINE_FINESTRA && sotto + t.height <= window.innerHeight - MARGINE_FINESTRA) top = sotto;
    // Centrato sull'ancora, poi rientrato nella finestra: un filtro all'estrema
    // destra avrebbe metà tooltip fuori.
    const centro = a.left + a.width / 2 - t.width / 2;
    const left = Math.max(MARGINE_FINESTRA, Math.min(centro, window.innerWidth - t.width - MARGINE_FINESTRA));
    setPos({ top: Math.max(MARGINE_FINESTRA, top), left });
  }, [aperto, side, content]);

  if (disabled || !content) return <>{children}</>;

  return (
    <>
      <span
        ref={wrapRef}
        // `contents`: il wrapper non deve esistere per il layout, altrimenti
        // un tooltip su un figlio flex ne cambia la disposizione.
        //
        // ATTENZIONE A CHI MISURA I FIGLI. Per il layout questo span non c'è,
        // ma nel DOM sì, e ha `offsetWidth` ZERO. Un contenitore che decide
        // qualcosa scorrendo `element.children` (per esempio: quanti chip
        // stanno in una riga) qui vede una fila di elementi larghi nulla e
        // conclude che ci stanno tutti. È già successo con la barra dei filtri
        // della board: i chip in eccesso finivano oltre il bordo invece che
        // dentro il menu. Chi misura deve selezionare i FIGLI VERI (per
        // testid o classe), non `children`.
        className="contents"
        onMouseEnter={apri}
        onMouseLeave={chiudi}
        // Il fuoco da tastiera lo apre SUBITO: chi tabula ha già dichiarato
        // dove sta guardando, farlo aspettare 350ms è solo attrito.
        onFocus={() => { if (!disabled && content) { stopTimer(); setPos(null); setAperto(true); } }}
        onBlur={chiudi}
        aria-describedby={aperto ? id : undefined}
      >
        {children}
      </span>
      {aperto && createPortal(
        <div
          ref={tipRef}
          id={id}
          role="tooltip"
          data-testid="app-tooltip"
          // `pointer-events-none`: il tooltip non deve mai rubare il mouse al
          // bottone che c'è sotto, o un click sul bordo non arriva.
          className="pointer-events-none fixed z-[100] max-w-xs rounded-lg border border-app-border bg-app-panel px-2.5 py-1.5 text-[11px] leading-snug text-app-text shadow-lg"
          style={{
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            // Invisibile finché non ha una posizione: un fotogramma nell'angolo
            // in alto a sinistra si vede, ed è il difetto classico dei tooltip
            // fatti in casa.
            visibility: pos ? 'visible' : 'hidden',
          }}
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
