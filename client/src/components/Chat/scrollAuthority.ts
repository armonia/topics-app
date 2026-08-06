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
 * Il secondo campo, `userHeld`, non è un terzo flag risorto: non risponde alla
 * stessa domanda con un'altra voce, ne risponde a una diversa — «chi ha in
 * mano lo scroll adesso». Le due si sovrapponevano finché nessuno pinnava
 * fuori dallo stream; da quando ci sono i pin sulla RIMISURA, «ancorato» non
 * bastava più a dire «puoi tirarlo giù». Sta comunque qui dentro, ed entrambe
 * si consultano da un punto solo.
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
 * Sotto questa distanza la vista è al fondo VERO, e la presa dell'utente si
 * scioglie (`userHeld`). Deve essere una manciata di pixel, non la tolleranza
 * dei 150: dentro quella banda ci sta comodamente uno che sta leggendo le
 * ultime righe, e scioglierglela lì significa ributtarcelo.
 */
export const BOTTOM_RELEASE_PX = 4;

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
  /**
   * L'utente ha le MANI sullo scroll e non è ancora tornato al fondo vero.
   *
   * Esiste perché `anchored` da solo non copriva la fascia sotto i 150px.
   * Lì l'autorità dice ancora «ancorato» — di proposito: un colpo di rotellina
   * da pochi pixel non deve far comparire il bottone «torna in fondo» — e per
   * un pezzo quella convinzione è stata innocua, perché fuori dallo stream
   * nessuno pinnava. Poi sono arrivati i pin sulla RIMISURA (il
   * ResizeObserver sulla lista, `totalListHeightChanged` fuori dall'apertura,
   * l'altezza del composer), e proprio dentro quella fascia: scorrere
   * all'insù, in una lista virtualizzata, MONTA righe nuove e cambia
   * l'altezza totale — cioè il gesto dell'utente si autoinnescava addosso il
   * pin che lo riportava giù. Il difetto era «scrollo su e mi ributta
   * sotto», e il pezzo mancante non era una soglia: era il fatto che nessuno
   * teneva il conto di CHI ha in mano lo scroll.
   *
   * Lo alza solo un gesto vero (rotellina, dito, trascinamento della barra):
   * di gesti l'app non ne produce. Lo scioglie solo il ritorno al fondo VERO
   * — `BOTTOM_RELEASE_PX`, non i 150 — o un intento esplicito (invio,
   * «torna in fondo», cambio di topic).
   */
  userHeld: boolean;
}

export const initialScrollAuthority: ScrollAuthorityState = {
  anchored: true,
  guardUntil: 0,
  userHeld: false,
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
  | {
      type: 'user-scrolled-up';
      streaming: boolean;
      distanceFromBottom?: number;
      /**
       * DA DOVE arriva la notizia, e non è un dettaglio: le due sorgenti hanno
       * affidabilità opposte.
       *
       *  • `gesture` — rotellina all'insù, trascinamento: un gesto, e di gesti
       *    l'app non ne produce. Non c'è niente da cui difendersi, quindi vince
       *    sempre, anche dentro la finestra di guardia.
       *  • `delta` — `scrollTop` è calato oltre soglia. AMBIGUO: lo fa anche
       *    Virtuoso quando rimisura le altezze dopo un nostro scroll forzato,
       *    ed è esattamente ciò per cui la guardia esiste.
       *
       * Assente = `delta`, cioè la lettura prudente: chi non dichiara la
       * sorgente non ottiene il permesso di scavalcare la guardia.
       */
      source?: 'gesture' | 'delta';
    }
  /**
   * Virtuoso: la vista è tornata in fondo.
   *
   * `teleported` = ci è arrivata di colpo da lontano, senza che l'avessimo
   * portata noi. Non è un gesto umano: è la lista che si è ri-ancorata da sé
   * dopo una rimisura. Vedi la transizione.
   *
   * `distanceFromBottom` distingue «Virtuoso considera questo il fondo»
   * (soglia 150) dal fondo VERO. Solo il secondo scioglie `userHeld`: chi si
   * è riportato a 100px dal fondo sta ancora leggendo, e riprendergli lo
   * scroll lì è lo stesso difetto di prima con un altro nome. Assente = si
   * comporta come prima (scioglie), così i chiamanti che non misurano non
   * cambiano semantica.
   */
  | { type: 'reached-bottom'; teleported?: boolean; distanceFromBottom?: number }
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

/** Alza la presa dell'utente — stessa regola di identità di `detach`. */
function hold(state: ScrollAuthorityState): ScrollAuthorityState {
  return state.userHeld ? state : { ...state, userHeld: true };
}

/**
 * Riancora e arma la guardia: la forma condivisa di ogni scroll forzato.
 *
 * `keepHold` serve a un solo caso, ed è quello che conta: un turno che
 * COMINCIA ri-afferma l'ancoraggio, ma non è un intento dell'utente — lo
 * avviano anche la board, un agente, un'altra finestra — quindi non ha nessun
 * diritto di sciogliergli la presa e trascinarlo in fondo.
 */
function reanchor(now: number, pin: boolean, keepHold = false): ScrollDecision {
  return { state: { anchored: true, guardUntil: now + SCROLL_GUARD_MS, userHeld: keepHold }, pin };
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
      return reanchor(now, false, state.userHeld);

    // Inviare È l'intento di seguire la risposta: vince anche su una vista che
    // l'utente aveva deliberatamente portato indietro a leggere.
    case 'user-sent':
    case 'scroll-to-bottom':
      return reanchor(now, true);

    case 'user-scrolled-up': {
      // Un GESTO alza la presa, e lo fa PRIMA di ogni altra considerazione.
      //
      // Non è un doppione di `anchored`: sotto i 150px l'autorità resta
      // ancorata di proposito (il bottone non deve comparire per un colpo di
      // rotellina), ed è esattamente lì che i pin sulla rimisura riportavano
      // giù chi stava scorrendo. La distanza qui non serve nemmeno
      // misurarla bene — cosa impossibile dentro `wheel`, che gira PRIMA che
      // il browser applichi il delta: un gesto è un gesto a qualunque
      // distanza, e di gesti l'app non ne produce.
      const held = (event.source ?? 'delta') === 'gesture' ? hold(state) : state;
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
      // …ma la guardia vale solo per la sorgente AMBIGUA. Un gesto vero
      // (rotellina, trascinamento) l'app non lo produce mai, quindi non c'è
      // niente da cui difendersi: sopprimerlo voleva dire ignorare l'utente per
      // 600ms dopo ogni nostro scroll forzato — cioè proprio nell'istante in cui
      // uno reagisce a un salto che non voleva.
      if (!event.streaming && (event.source ?? 'delta') === 'delta' && now < state.guardUntil) {
        return { state: held, pin: false };
      }
      // Durante lo stream sganciare deve essere IMMEDIATO: il pin gira a ogni
      // chunk e, se aspettassimo l'atBottomStateChange di Virtuoso, ributterebbe
      // la vista in fondo prima che quello arrivi — l'utente resterebbe
      // inchiodato al fondo.
      if (event.streaming) return detach(held);
      // Fuori dallo stream nessuno sta combattendo con lui, quindi un colpo di
      // rotellina da pochi pixel non deve far comparire il bottone: sgancia
      // solo se la vista è DAVVERO lontana dal fondo. Con la distanza si
      // sgancia subito; senza (chiamante che non sa misurarla) decide come
      // prima la geometria di Virtuoso, che però tace finché non supera la sua
      // soglia — ed è lì che l'aggancio sembrava incollato.
      if (event.distanceFromBottom != null && event.distanceFromBottom > AT_BOTTOM_TOLERANCE_PX) {
        return detach(held);
      }
      return { state: held, pin: false };
    }

    case 'reached-bottom': {
      // Un salto in fondo che non abbiamo fatto noi e che l'utente non ha
      // compiuto — la lista che si ri-ancora da sé dopo una rimisura — non è un
      // ritorno in fondo: è il difetto. Perdonarlo significava incollare la
      // vista per il resto della sessione a chi stava leggendo indietro.
      if (event.teleported) return { state, pin: false };
      // La presa si scioglie solo al fondo VERO. Virtuoso chiama «in fondo»
      // tutto ciò che sta entro 150px, e a 100px dal fondo si sta ancora
      // leggendo: sciogliere lì rimetterebbe in circolo i pin sulla rimisura
      // addosso a chi non ha ancora finito.
      const atTrueBottom =
        event.distanceFromBottom == null || event.distanceFromBottom <= BOTTOM_RELEASE_PX;
      const released = state.userHeld && atTrueBottom ? { ...state, userHeld: false } : state;
      // Tornare in fondo perdona tutto: la crescita successiva riaggancia.
      if (released.anchored) return { state: released, pin: false };
      return { state: { ...released, anchored: true }, pin: false };
    }

    case 'left-bottom':
      // Durante lo stream questo evento NON è mai l'utente — quello passa da
      // `user-scrolled-up` e ha già sganciato. È un tool block che ha fatto
      // crescere il contenuto sotto la posizione pinnata: si ri-asserisce il
      // pin e si resta incollati.
      if (event.streaming) {
        return { state, pin: state.anchored };
      }
      // Fuori dallo stream, DENTRO la finestra di guardia: non sgancia mai, e
      // la distanza non c'entra.
      //
      // Prima si perdonava solo uno scarto piccolo, e il caso che rompeva era
      // quello grande — che è anche il più comune. Premi «Riprova» (o invii, o
      // apri la chat): riancoriamo e pinniamo, poi arriva la riga nuova, il
      // banner sparisce, il composer cambia altezza e la lista si rimisura. Per
      // un attimo Virtuoso annuncia una distanza dal fondo di parecchie
      // centinaia di pixel — roba NOSTRA, non un gesto — e con la vecchia
      // condizione quello sganciava: da lì in poi ogni pin era vietato e la
      // risposta scorreva via sotto una vista ferma. È il «faccio Riprova e si
      // perde l'aggancio».
      //
      // Perdonare tutto qui non toglie all'utente il controllo: il suo gesto ha
      // il suo evento (`user-scrolled-up`, sorgente `gesture`), che sgancia
      // subito anche dentro la guardia. Questo evento invece non sa chi l'ha
      // causato, e in questa finestra la risposta giusta è: l'abbiamo causato noi.
      if (now < state.guardUntil) return { state, pin: false };
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
 *
 * `userHeld` è il secondo veto, e vale per la stessa ragione: mentre l'utente
 * ha in mano lo scroll, la viewport è SUA. Sta qui e non nei singoli punti che
 * pinnano — sono cinque e ognuno se lo sarebbe dimenticato in modo diverso,
 * che è precisamente la storia raccontata in cima a questo file.
 */
export function shouldPin(
  state: ScrollAuthorityState,
  ctx: { jumpPending: boolean },
): boolean {
  if (ctx.jumpPending) return false;
  if (state.userHeld) return false;
  return state.anchored;
}

/** `scrollTop` è calato abbastanza da essere l'utente e non jitter di rimisura? */
export function isUserScrollUp(previousScrollTop: number, scrollTop: number): boolean {
  return scrollTop < previousScrollTop - USER_SCROLL_UP_PX;
}
