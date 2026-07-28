/**
 * L'AUTORITÀ SULLO SCROLL DELLA CHAT — una sola, e qui dentro.
 *
 * Prima la domanda «la vista deve restare incollata in fondo?» aveva TRE
 * risposte che si riparavano a vicenda — `isScrolledUpRef`, `userIntentUpRef`,
 * `scrollGuardRef` — e otto punti che pinnavano il fondo, ognuno con un
 * sottoinsieme DIVERSO di quei tre come guardia. Ogni bug live (la vista che
 * "perde l'aggancio da solo", il salto da palette annullato 150ms dopo, il
 * "non riesco a scrollare su durante lo stream", il loader che finisce sotto
 * l'input) è nato da un punto che leggeva un sottoinsieme sbagliato. I commenti
 * in MessageList erano diventati un catalogo di autopsie.
 *
 * Qui la domanda ha UNA risposta — `anchored` — e la logica è un riduttore
 * puro, quindi testabile senza un browser. Le transizioni sono tutte e sole
 * quelle sotto; i punti che pinnano non decidono più niente, chiedono e basta
 * (`shouldPin`).
 *
 * Nota sul terzo flag scomparso. `userIntentUpRef` esisteva per distinguere
 * «l'utente ha afferrato lo scroll» da «un tool block ha fatto crescere il
 * contenuto sotto la posizione pinnata» (che NON è uno scroll dell'utente e
 * non deve sganciare). Quella distinzione ora vive nelle TRANSIZIONI, non in
 * un flag: durante lo stream `left-bottom` non sgancia mai — ri-asserisce il
 * pin — e l'unica cosa che sgancia è `user-scrolled-up`. Fuori dallo stream
 * `userIntentUp` non aveva più nessun lettore: era `anchored` scritto due
 * volte.
 */

/** Finestra in cui un atBottomStateChange(false) è rumore di misura, non l'utente. */
export const SCROLL_GUARD_MS = 600;

/**
 * Sotto questa distanza dal fondo, un "non sei in fondo" dentro la finestra di
 * guardia è il riassestamento di Virtuoso dopo uno scroll forzato. Coincide con
 * `atBottomThreshold` della lista: l'ancoraggio iniziale si posa ~una riga sopra
 * il fondo vero mentre Virtuoso rimisura le altezze, e a 50px quel ritardo
 * sganciava per sempre l'auto-scroll dei messaggi in arrivo.
 */
export const AT_BOTTOM_TOLERANCE_PX = 150;

/**
 * Un offset ripristinato (undo di una pane) sgancia solo se lascia la vista
 * davvero lontana dal fondo. Banda più STRETTA della tolleranza live apposta:
 * un ripristino deliberato non va arrotondato al fondo.
 */
export const RESTORE_DETACH_PX = 50;

/**
 * Calo di `scrollTop` che vale come "l'utente ha tirato su la vista". Sotto
 * questa soglia è jitter di rimisura — il pin dell'app alza `scrollTop`, non lo
 * abbassa mai, quindi un calo vero è sempre l'utente.
 */
export const USER_SCROLL_UP_PX = 24;

export interface ScrollAuthorityState {
  /**
   * La vista è ancorata al fondo: la crescita del contenuto deve tenercela.
   * È l'UNICA domanda che i punti che pinnano hanno il diritto di fare.
   */
  anchored: boolean;
  /** Istante fino al quale gli scarti di misura non contano come sgancio. */
  guardUntil: number;
}

export const initialScrollAuthority: ScrollAuthorityState = {
  anchored: true,
  guardUntil: 0,
};

export type ScrollEvent =
  /** Cambio di topic: la lista si rimonta, si riparte ancorati. */
  | { type: 'topic-switch' }
  /** Un turno inizia a streammare: si riparte ancorati (l'utente ha appena inviato). */
  | { type: 'stream-start' }
  /** L'utente ha inviato: intento esplicito di seguire la risposta, comunque fosse la vista. */
  | { type: 'user-sent' }
  /** Il bottone "torna in fondo", o qualunque richiesta esplicita di riancorare. */
  | { type: 'scroll-to-bottom' }
  /** Rotellina verso l'alto, o `scrollTop` calato oltre soglia: è l'utente. */
  | { type: 'user-scrolled-up'; streaming: boolean }
  /** Virtuoso: la vista è tornata in fondo. */
  | { type: 'reached-bottom' }
  /** Virtuoso: la vista non è più in fondo. Può essere l'utente o la crescita del contenuto. */
  | { type: 'left-bottom'; streaming: boolean; distanceFromBottom: number }
  /** Offset ripristinato da un undo di pane. */
  | { type: 'offset-restored'; distanceFromBottom: number };

export interface ScrollDecision {
  state: ScrollAuthorityState;
  /** true ⇒ chi ha mandato l'evento deve pinnare lo scroller in fondo, ora. */
  pin: boolean;
}

/** Riancora e arma la guardia: la forma condivisa di ogni scroll forzato. */
function reanchor(now: number, pin: boolean): ScrollDecision {
  return { state: { anchored: true, guardUntil: now + SCROLL_GUARD_MS }, pin };
}

export function reduceScroll(
  state: ScrollAuthorityState,
  event: ScrollEvent,
  now: number,
): ScrollDecision {
  switch (event.type) {
    // Il pin vero lo fa l'effetto che aspetta il caricamento: qui si riparte
    // ancorati e si arma la guardia perché la lista sta per rimisurarsi tutta.
    case 'topic-switch':
      return reanchor(now, false);

    // Virtuoso può riportare atBottom=false per un frame mentre i due nuovi item
    // (messaggio utente + placeholder) vengono misurati: senza riancorare qui,
    // quel falso negativo bloccherebbe il pin per tutto il turno.
    case 'stream-start':
      return reanchor(now, false);

    // Inviare È l'intento di seguire la risposta: vince anche su una vista che
    // l'utente aveva deliberatamente portato indietro a leggere.
    case 'user-sent':
    case 'scroll-to-bottom':
      return reanchor(now, true);

    case 'user-scrolled-up':
      // Durante lo stream sganciare deve essere IMMEDIATO: il pin gira a ogni
      // chunk e, se aspettassimo l'atBottomStateChange di Virtuoso, ributterebbe
      // la vista in fondo prima che quello arrivi — l'utente resterebbe
      // inchiodato al fondo. Fuori dallo stream nessuno sta combattendo con lui:
      // decide la geometria (`left-bottom` con la sua tolleranza), così un
      // colpo di rotellina da pochi pixel non fa comparire il bottone.
      if (!event.streaming) return { state, pin: false };
      return { state: { ...state, anchored: false }, pin: false };

    case 'reached-bottom':
      // Tornare in fondo perdona tutto: la crescita successiva riaggancia.
      return { state: { ...state, anchored: true }, pin: false };

    case 'left-bottom':
      // Durante lo stream questo evento NON è mai l'utente — quello passa da
      // `user-scrolled-up` e ha già sganciato. È un tool block che ha fatto
      // crescere il contenuto sotto la posizione pinnata: si ri-asserisce il
      // pin e si resta incollati.
      if (event.streaming) {
        return { state, pin: state.anchored };
      }
      // Fuori dallo stream: dentro la finestra di guardia uno scarto piccolo è
      // il riassestamento del nostro stesso scroll forzato, non l'utente.
      if (now < state.guardUntil && event.distanceFromBottom < AT_BOTTOM_TOLERANCE_PX) {
        return { state, pin: false };
      }
      return { state: { ...state, anchored: false }, pin: false };

    case 'offset-restored':
      if (event.distanceFromBottom <= RESTORE_DETACH_PX) return { state, pin: false };
      return { state: { ...state, anchored: false }, pin: false };

    default: {
      // Esaustività a compile-time: un evento nuovo senza transizione non compila.
      const never: never = event;
      return { state: never as unknown as ScrollAuthorityState, pin: false };
    }
  }
}

/**
 * La UNICA domanda che un punto che pinna ha il diritto di fare.
 *
 * `jumpPending` = c'è un salto da palette in corso per questa topic. Il veto sta
 * qui, e non ripetuto in sei punti: il salto possiede la viewport finché la sua
 * breve grazia non scade, e ogni ancoraggio al fondo lo annullerebbe (era il
 * bug: `scrollTop 0 → fondo` entro 100ms dal salto).
 */
export function shouldPin(
  state: ScrollAuthorityState,
  ctx: { jumpPending: boolean },
): boolean {
  if (ctx.jumpPending) return false;
  return state.anchored;
}

/** `scrollTop` è calato abbastanza da essere l'utente e non jitter di rimisura? */
export function isUserScrollUp(previousScrollTop: number, scrollTop: number): boolean {
  return scrollTop < previousScrollTop - USER_SCROLL_UP_PX;
}
