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
  /**
   * Un turno comincia a streammare. NON è per forza un turno dell'utente: può
   * averlo avviato la board, un'altra finestra, o un agente. Ri-AFFERMA
   * l'ancoraggio, non lo crea — vedi la transizione.
   */
  | { type: 'stream-start' }
  /** L'utente ha inviato: intento esplicito di seguire la risposta, comunque fosse la vista. */
  | { type: 'user-sent' }
  /** Il bottone "torna in fondo", o qualunque richiesta esplicita di riancorare. */
  | { type: 'scroll-to-bottom' }
  /**
   * Rotellina verso l'alto, o `scrollTop` calato oltre soglia: è l'utente.
   * `distanceFromBottom` (quando il chiamante sa misurarla) evita di aspettare
   * Virtuoso fuori dallo stream.
   */
  | { type: 'user-scrolled-up'; streaming: boolean; distanceFromBottom?: number }
  /**
   * Virtuoso: la vista è tornata in fondo.
   *
   * `teleported` = ci è arrivata di colpo da lontano, senza che l'avessimo
   * portata noi. Non è un gesto umano: è la lista che si è ri-ancorata da sé
   * dopo una rimisura. Vedi la transizione.
   */
  | { type: 'reached-bottom'; teleported?: boolean }
  /** Virtuoso: la vista non è più in fondo. Può essere l'utente o la crescita del contenuto. */
  | { type: 'left-bottom'; streaming: boolean; distanceFromBottom: number }
  /** Offset ripristinato da un undo di pane. */
  | { type: 'offset-restored'; distanceFromBottom: number };

export interface ScrollDecision {
  state: ScrollAuthorityState;
  /** true ⇒ chi ha mandato l'evento deve pinnare lo scroller in fondo, ora. */
  pin: boolean;
}

/**
 * Sgancia — e se era già sganciato NON crea un oggetto nuovo.
 *
 * Non è un vezzo: questo stato vive in un `useReducer`, e un oggetto nuovo a
 * ogni evento è un render nuovo a ogni evento. Gli eventi di scroll arrivano a
 * raffica (uno per frame mentre il dito trascina), quindi «stessa risposta,
 * oggetto diverso» significa far rimisurare la lista virtualizzata decine di
 * volte al secondo — e una lista che rimisura mentre stai leggendo ti sposta la
 * vista sotto gli occhi. Il riduttore restituisce lo STESSO stato quando non
 * cambia niente.
 */
function detach(state: ScrollAuthorityState): ScrollDecision {
  if (!state.anchored) return { state, pin: false };
  return { state: { ...state, anchored: false }, pin: false };
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
    //
    // Ma ri-afferma soltanto: se l'utente era andato indietro a leggere, un
    // turno che comincia NON deve trascinarlo in fondo. Un turno non è sempre
    // suo — lo avviano anche la board, un agente, un'altra finestra — e
    // «l'utente ha appena inviato» ha già il suo evento (`user-sent`), che
    // riancora comunque. Questo era il salto in fondo mentre si leggeva.
    case 'stream-start':
      if (!state.anchored) return { state, pin: false };
      return reanchor(now, false);

    // Inviare È l'intento di seguire la risposta: vince anche su una vista che
    // l'utente aveva deliberatamente portato indietro a leggere.
    case 'user-sent':
    case 'scroll-to-bottom':
      return reanchor(now, true);

    case 'user-scrolled-up':
      // Dentro la finestra di guardia il calo di `scrollTop` è NOSTRO, non suo.
      //
      // «Il pin alza soltanto, quindi un calo è sempre l'utente» era vero per un
      // `scrollTop = scrollHeight` secco, ma non per come si incolla davvero a
      // una lista virtualizzata: `scrollToIndex('LAST')` porta la vista in fondo
      // e poi Virtuoso rimisura le altezze, e quel riassestamento ABBASSA
      // `scrollTop` di qualche decina di pixel. Preso per l'utente, sganciava il
      // pin appena arrivato: il bottone «torna in fondo» ti portava giù e la
      // vista se ne ristaccava da sola un istante dopo. La guardia la arma ogni
      // scroll forzato — è esattamente la finestra in cui il movimento è il
      // nostro che si assesta.
      // …ma SOLO fuori dallo stream. Durante lo stream il pin scrive
      // `scrollTop = scrollHeight` e basta — alza e non abbassa mai — quindi lì
      // un calo è davvero l'utente, e farlo aspettare la fine della guardia
      // vorrebbe dire tenerlo inchiodato al fondo mentre cerca di leggere.
      if (!event.streaming && now < state.guardUntil) return { state, pin: false };
      // Durante lo stream sganciare deve essere IMMEDIATO: il pin gira a ogni
      // chunk e, se aspettassimo l'atBottomStateChange di Virtuoso, ributterebbe
      // la vista in fondo prima che quello arrivi — l'utente resterebbe
      // inchiodato al fondo.
      if (event.streaming) return detach(state);
      // Fuori dallo stream nessuno sta combattendo con lui, quindi un colpo di
      // rotellina da pochi pixel non deve far comparire il bottone: sgancia
      // solo se la vista è DAVVERO lontana dal fondo. Con la distanza si
      // sgancia subito; senza (chiamante che non sa misurarla) decide come
      // prima la geometria di Virtuoso, che però tace finché non supera la sua
      // soglia — ed è lì che l'aggancio sembrava incollato.
      if (event.distanceFromBottom != null && event.distanceFromBottom > AT_BOTTOM_TOLERANCE_PX) {
        return detach(state);
      }
      return { state, pin: false };

    case 'reached-bottom':
      // Un salto in fondo che non abbiamo fatto noi e che l'utente non ha
      // compiuto — la lista che si ri-ancora da sé dopo una rimisura — non è un
      // ritorno in fondo: è il difetto. Perdonarlo significava incollare la
      // vista per il resto della sessione a chi stava leggendo indietro.
      if (event.teleported) return { state, pin: false };
      // Tornare in fondo perdona tutto: la crescita successiva riaggancia.
      if (state.anchored) return { state, pin: false };
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
      return detach(state);

    case 'offset-restored':
      if (event.distanceFromBottom <= RESTORE_DETACH_PX) return { state, pin: false };
      return detach(state);

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
