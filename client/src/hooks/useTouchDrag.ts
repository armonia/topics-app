/**
 * useTouchDrag — «tieni premuto, poi trascina», il gesto che su iPhone SOSTITUISCE
 * il drag nativo di HTML5.
 *
 * ── Il buco che chiude ──────────────────────────────────────────────────────
 * Attilio, 07/08: «vedo che il drag and drop non funziona da PWA sulla sidebar.
 * Questa cosa ci serve per i pinnati». Non era una svista nostra: il drag and
 * drop di HTML5 — `draggable`, `dragstart`, `dragover`, `drop` — **non esiste su
 * iOS**. Safari non emette nessuno di quegli eventi da un tocco, quindi ogni
 * superficie che riordina via `dataTransfer` è, sul telefono, inerte per
 * costruzione. Il codice della griglia dei fissati infatti spegne già il
 * `draggable` su touch (`draggable={!isTouch}`), perché il "lift" nativo, dove
 * esiste, contende lo stesso dito del «tieni premuto». Il risultato era che col
 * dito non restava NESSUN modo di spostare una tessera.
 *
 * ── Il gesto ────────────────────────────────────────────────────────────────
 * È quello della schermata Home di iOS, e si impara perché lo si conosce già:
 *
 *   premi ──500ms──▶ SOLLEVATA ──muovi──▶ trascini ──stacca──▶ posa
 *                        │
 *                        └──stacca senza muovere──▶ menu contestuale
 *
 * Un gesto solo, tre esiti, nessuna ambiguità: prima dei 500ms il dito è ancora
 * uno scorrimento (e infatti oltre la tolleranza il gesto si annulla e la lista
 * scorre); dopo, il dito è della tessera.
 *
 * ── Perché i listener sono NATIVI e non quelli di React ─────────────────────
 * Da React 17 il root registra `touchstart`, `touchmove` e `wheel` come
 * **passivi**: dentro un `onTouchMove` di React `preventDefault()` è un no-op
 * (con tanto di avviso in console). Senza quel `preventDefault` la pagina scorre
 * SOTTO la tessera mentre la trascini, cioè il gesto è inservibile. Quindi la
 * fase di trascinamento si aggancia a `document` con `{ passive: false }`, e ha
 * il vantaggio necessario di seguire il dito anche fuori dall'elemento di
 * partenza — che è tutto il punto di un trascinamento.
 *
 * La fase PRIMA del sollevamento resta sugli handler di React: lì non si
 * previene niente, e il tocco deve poter diventare uno scorrimento normale.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { haptic } from './useMobile';
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX, type LongPressTarget } from './useLongPress';

/** Quanto deve muoversi il dito, dopo il sollevamento, perché sia un
 *  trascinamento e non un tremolio. Più stretta della tolleranza d'ingresso: a
 *  gesto già armato l'intenzione è dichiarata, e aspettare altri 10px farebbe
 *  sembrare la tessera incollata. */
const DRAG_START_PX = 4;

export interface TouchDragCallbacks {
  /** Off = nessun handler (desktop: lì c'è il drag nativo e il tasto destro). */
  enabled?: boolean;
  /** Rilasciato senza muovere: è un «tieni premuto» classico. */
  onPress?: (target: LongPressTarget) => void;
  /** La tessera si è sollevata: da qui in poi il dito è suo. */
  onLift?: () => void;
  /** Il dito si muove, in coordinate viewport. */
  onMove?: (x: number, y: number) => void;
  /** Il dito si stacca dopo aver trascinato. */
  onDrop?: (x: number, y: number) => void;
  /** Il trascinamento NON c'è stato: annullato dal sistema, oppure rilasciato
   *  senza muoversi. Serve a rimettere a posto ciò che `onLift` ha alzato — ed
   *  è chiamato anche prima di `onPress`, per lo stesso motivo. */
  onCancel?: () => void;
}

export interface TouchDragBinding {
  /** Fra l'inizio della pressione e il sollevamento: per il feedback visivo. */
  pressed: boolean;
  /** Sollevata e in movimento. */
  dragging: boolean;
  /** In cima all'`onClick`: `true` se quel clic è l'eco del gesto. */
  consumeClick: () => boolean;
  handlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
    onTouchCancel: () => void;
  };
}

export function useTouchDrag({
  enabled = true,
  onPress,
  onLift,
  onMove,
  onDrop,
  onCancel,
}: TouchDragCallbacks): TouchDragBinding {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const liftedRef = useRef(false);
  const draggedRef = useRef(false);
  const firedRef = useRef(false);
  /** Lo smontaggio dei listener nativi, uno per gesto. */
  const detachRef = useRef<(() => void) | null>(null);
  /** L'ancora del menu, catturata al SOLLEVAMENTO: al rilascio il
   *  `currentTarget` dell'evento sintetico di React è già stato riciclato. */
  const pressTargetRef = useRef<LongPressTarget | null>(null);
  const [pressed, setPressed] = useState(false);
  const [dragging, setDragging] = useState(false);

  // I callback vivono in un ref: gli handler restano stabili anche quando il
  // chiamante ricrea le closure a ogni render (il caso normale — catturano la
  // chiave della riga).
  const cbRef = useRef({ onPress, onLift, onMove, onDrop, onCancel });
  useEffect(() => {
    cbRef.current = { onPress, onLift, onMove, onDrop, onCancel };
  }, [onPress, onLift, onMove, onDrop, onCancel]);

  const reset = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    detachRef.current?.();
    detachRef.current = null;
    originRef.current = null;
    liftedRef.current = false;
    draggedRef.current = false;
    setPressed(false);
    setDragging(false);
  }, []);

  // Un gesto armato non deve sopravvivere all'elemento che l'ha armato: una
  // tessera che sparisce mentre la tieni premuta lascerebbe listener su
  // `document` che parlano di una chiave che non esiste più.
  useEffect(() => reset, [reset]);

  /**
   * La fase di trascinamento: `document`, non passiva, IN CATTURA, e si smonta
   * da sola.
   *
   * ── Perché in cattura ────────────────────────────────────────────────────
   * Non è simmetria stilistica: in bolla `document` è l'ULTIMO a ricevere, cioè
   * dopo che ogni handler lungo la strada ha già fatto la sua parte. E lungo la
   * strada c'è lo swipe che CHIUDE la sidebar mobile — `-60px` sul contenitore
   * (`useSidebarAndLayout.handleSidebarTouchEnd`). Trascinare una tessera di
   * sei centimetri verso sinistra è esattamente quel movimento: il cassetto si
   * sarebbe chiuso sotto il dito, portandosi via la griglia su cui stavi
   * lavorando. In cattura questi listener vedono l'evento per PRIMI e lo
   * fermano lì: mentre trascini, il tocco è nostro e di nessun altro.
   */
  const attachDragPhase = useCallback(() => {
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      // QUI sta il motivo dei listener nativi: senza, la lista scorre sotto la
      // tessera che stai trascinando.
      e.preventDefault();
      e.stopPropagation();
      if (!draggedRef.current) {
        const o = originRef.current;
        const dx = o ? t.clientX - o.x : 0;
        const dy = o ? t.clientY - o.y : 0;
        if (dx * dx + dy * dy < DRAG_START_PX * DRAG_START_PX) return;
        draggedRef.current = true;
        setDragging(true);
      }
      cbRef.current.onMove?.(t.clientX, t.clientY);
    };
    // IL RILASCIO LO DECIDE QUI, TUTTO.
    //
    // In cattura su `document` questo listener vede il `touchend` PRIMA della
    // delega di React, e lo ferma: l'`onTouchEnd` di React sull'elemento non
    // scatta più. Quindi anche il caso «sollevata ma mai mossa» — il «tieni
    // premuto» che apre il menu — deve essere servito da qui, o sarebbe un
    // gesto che sparisce fra due handler.
    const end = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      const dragged = draggedRef.current;
      const target = pressTargetRef.current;
      // Il tocco è nostro: non risale (lo swipe di chiusura della sidebar) e
      // non genera il clic sintetico che riaprirebbe la tessera sotto il menu.
      e.stopPropagation();
      e.preventDefault();
      // Prima si smonta, poi si consegna: un callback che ri-renderizza mentre
      // i listener sono ancora su `document` può far arrivare un secondo evento
      // dentro un gesto già concluso.
      reset();
      if (dragged && t) { cbRef.current.onDrop?.(t.clientX, t.clientY); return; }
      // Nessun trascinamento: prima si rimette a posto lo stato che il
      // sollevamento ha alzato (la griglia si crede in movimento), poi si apre
      // il menu. L'ordine conta: aprirlo su una griglia ancora "in volo"
      // lascerebbe l'anteprima accesa sotto il menu.
      cbRef.current.onCancel?.();
      if (target) cbRef.current.onPress?.(target);
    };
    const cancel = () => { reset(); cbRef.current.onCancel?.(); };
    document.addEventListener('touchmove', move, { passive: false, capture: true });
    document.addEventListener('touchend', end, true);
    document.addEventListener('touchcancel', cancel, true);
    detachRef.current = () => {
      document.removeEventListener('touchmove', move, true);
      document.removeEventListener('touchend', end, true);
      document.removeEventListener('touchcancel', cancel, true);
    };
  }, [reset]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (!enabled) return;
    // Due dita = pinch/scroll, non una pressione.
    if (e.touches.length !== 1) { reset(); return; }
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
      liftedRef.current = true;
      firedRef.current = true;
      setPressed(false);
      haptic('medium');
      pressTargetRef.current = { element, touched, x, y };
      cbRef.current.onLift?.();
      attachDragPhase();
    }, LONG_PRESS_MS);
  }, [enabled, reset, attachDragPhase]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    // Dopo il sollevamento comanda il listener nativo; qui si guarda solo se il
    // dito se n'è andato PRIMA che il gesto scattasse — nel qual caso era uno
    // scorrimento, e la lista deve scorrere.
    if (liftedRef.current || !timerRef.current || !originRef.current) return;
    const t = e.touches[0];
    if (!t) { reset(); return; }
    const dx = t.clientX - originRef.current.x;
    const dy = t.clientY - originRef.current.y;
    if (dx * dx + dy * dy > LONG_PRESS_SLOP_PX * LONG_PRESS_SLOP_PX) reset();
  }, [reset]);

  // Il rilascio PRIMA del sollevamento: un tocco breve, che è un clic normale e
  // deve restare tale. Dopo il sollevamento questo handler non viene mai
  // chiamato — il listener in cattura su `document` ha già fermato l'evento — e
  // il `reset` qui è solo la rete per il caso in cui il timer sia ancora armato.
  const onTouchEnd = useCallback(() => { reset(); }, [reset]);

  const onTouchCancel = useCallback(() => {
    const wasLifted = liftedRef.current;
    firedRef.current = false;
    reset();
    if (wasLifted) cbRef.current.onCancel?.();
  }, [reset]);

  const consumeClick = useCallback(() => {
    if (!firedRef.current) return false;
    firedRef.current = false;
    return true;
  }, []);

  return {
    pressed,
    dragging,
    consumeClick,
    handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel },
  };
}
