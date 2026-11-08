import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Un tasto solo, due gesti: il TAP che resta acceso e la PRESSIONE TENUTA che
 * dura quanto il dito.
 *
 * Sono due abitudini diverse e nessuna delle due copre l'altra. Al tavolo si
 * detta un paragrafo, e tenere premuto per un minuto è assurdo: serve il tap,
 * che lascia il microfono acceso finché non lo richiudi. Dal telefono si butta
 * dentro una frase in tre secondi, e il tap costa DUE tocchi separati da una
 * pausa in cui devi ricordarti che stai registrando: lì serve il walkie-talkie,
 * premi-parla-molla.
 *
 * A distinguerli è solo il TEMPO del rilascio, e il grosso della cura sta in
 * due punti:
 *
 *  · LA REGISTRAZIONE PARTE AL `pointerdown`, subito, non alla soglia. Su iOS
 *    `getUserMedia` vuole un gesto dell'utente, e un timer di mezzo secondo in
 *    mezzo spende quel diritto: il permesso arriverebbe fuori dal gesto e il
 *    microfono non si aprirebbe. La soglia serve solo a decidere cosa fa il
 *    RILASCIO, e a quel punto l'audio è già in cassa.
 *  · POINTER, non touch né mouse. I pointer event coprono dito, penna e mouse
 *    con gli stessi handler, e sono l'unico modo di avere il rilascio (che il
 *    touch dà, ma solo su touch) senza scrivere due volte la stessa macchina.
 */

/** Oltre questo, il rilascio ferma: sotto, era un tap e il microfono resta su. */
export const HOLD_TO_TALK_MS = 350;

/**
 * `armed` = il dito è giù e non sappiamo ancora se è un tap o una tenuta.
 * `latched` = era un tap, il microfono resta acceso e aspetta il tocco che chiude.
 */
export type TalkPhase = 'idle' | 'armed' | 'latched';

export type TalkEvent =
  | { type: 'down'; at: number }
  | { type: 'up'; at: number }
  | { type: 'cancel' };

/** Cosa deve fare il chiamante al microfono. `null` = niente, il gesto continua. */
export type TalkAction = 'start' | 'stop' | null;

/**
 * La macchina del gesto, pura: stessa coppia (stato, evento) sempre lo stesso
 * esito. Sta fuori dal hook perché è l'unico pezzo che si può sbagliare in
 * silenzio, ed è quello che il test unitario guida evento per evento.
 */
export function talkGestureReducer(
  phase: TalkPhase,
  pressedAt: number | null,
  event: TalkEvent,
  holdMs: number = HOLD_TO_TALK_MS,
): { phase: TalkPhase; pressedAt: number | null; action: TalkAction } {
  switch (phase) {
    case 'idle':
      // Il tocco che apre. L'`up` di un tocco che ha appena CHIUSO una dettatura
      // arriva anche lui qui, e non deve riaprirla.
      if (event.type === 'down') return { phase: 'armed', pressedAt: event.at, action: 'start' };
      return { phase: 'idle', pressedAt: null, action: null };

    case 'armed': {
      if (event.type === 'cancel') return { phase: 'idle', pressedAt: null, action: 'stop' };
      if (event.type === 'up') {
        const held = pressedAt === null ? 0 : event.at - pressedAt;
        // Tenuto: il rilascio è la fine della frase. Toccato: resta acceso, e a
        // chiuderlo sarà il tocco dopo.
        return held >= holdMs
          ? { phase: 'idle', pressedAt: null, action: 'stop' }
          : { phase: 'latched', pressedAt: null, action: null };
      }
      // Un secondo `down` senza rilascio (due dita): il gesto in corso comanda.
      return { phase: 'armed', pressedAt, action: null };
    }

    case 'latched':
      // Acceso da un tap: il tocco successivo chiude, e il suo rilascio non fa
      // niente perché a quel punto siamo già tornati in `idle`.
      if (event.type === 'down') return { phase: 'idle', pressedAt: null, action: 'stop' };
      if (event.type === 'cancel') return { phase: 'idle', pressedAt: null, action: 'stop' };
      return { phase: 'latched', pressedAt: null, action: null };
  }
}

export interface TalkGestureBinding {
  /** Vero mentre il dito è giù: per accendere il tasto prima ancora di sapere che gesto è. */
  pressing: boolean;
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: () => void;
    onContextMenu: (e: React.MouseEvent) => void;
  };
}

/**
 * Aggancia la macchina qui sopra a un elemento. `start`/`stop` sono il
 * microfono del chiamante: questo hook non sa cosa siano, decide solo quando.
 */
export function useTalkGesture(opts: {
  start: () => void;
  stop: () => void;
  /** Off = handler inerti (nessun motore di dettatura disponibile). */
  enabled?: boolean;
  holdMs?: number;
}): TalkGestureBinding {
  const { start, stop, enabled = true, holdMs = HOLD_TO_TALK_MS } = opts;
  const [pressing, setPressing] = useState(false);
  const phaseRef = useRef<TalkPhase>('idle');
  const pressedAtRef = useRef<number | null>(null);

  // I callback cambiano identità a ogni render del composer: letti da un ref,
  // gli handler restano stabili e il tasto non si rimonta mentre lo tieni giù.
  const startRef = useRef(start);
  const stopRef = useRef(stop);
  useEffect(() => { startRef.current = start; stopRef.current = stop; }, [start, stop]);

  const dispatch = useCallback((event: TalkEvent) => {
    const next = talkGestureReducer(phaseRef.current, pressedAtRef.current, event, holdMs);
    phaseRef.current = next.phase;
    pressedAtRef.current = next.pressedAt;
    if (next.action === 'start') startRef.current();
    else if (next.action === 'stop') stopRef.current();
  }, [holdMs]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!enabled) return;
    // Il tasto tiene il pointer fino al rilascio: senza cattura, un dito che
    // scivola di due pixel fuori dal bordo non consegna mai l'`up`, e il
    // microfono resterebbe aperto a registrare il nulla.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // Il campo di testo NON deve perdere il fuoco: il cursore lì dentro è il
    // punto in cui la voce andrà a finire.
    e.preventDefault();
    setPressing(true);
    dispatch({ type: 'down', at: Date.now() });
  }, [dispatch, enabled]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!enabled) return;
    e.preventDefault();
    setPressing(false);
    dispatch({ type: 'up', at: Date.now() });
  }, [dispatch, enabled]);

  const onPointerCancel = useCallback(() => {
    if (!enabled) return;
    setPressing(false);
    dispatch({ type: 'cancel' });
  }, [dispatch, enabled]);

  // Tenere premuto su iOS chiama il menu di sistema sopra il tasto, e su
  // desktop il tasto destro apre quello del browser: entrambi rubano il gesto.
  const onContextMenu = useCallback((e: React.MouseEvent) => { e.preventDefault(); }, []);

  return { pressing, handlers: { onPointerDown, onPointerUp, onPointerCancel, onContextMenu } };
}
