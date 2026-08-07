/**
 * LA MICRO-VIBRAZIONE — una porta sola, e la verità su iPhone scritta qui dentro.
 *
 * `haptic()` è l'unico punto da cui l'app chiede una pulsazione al dispositivo.
 * Dentro c'è UNA strada, non tre: `navigator.vibrate`. Questo file esiste per
 * dire, nero su bianco e con le fonti, PERCHÉ non ce ne sono altre — perché la
 * seconda strada (quella che tutti trovano cercando «haptic feedback iOS web»)
 * è stata chiusa da Apple e chi la riaggiunge fra sei mesi deve leggerlo qui
 * prima di scriverla, non dopo.
 *
 * ── Cosa funziona ────────────────────────────────────────────────────────────
 * `navigator.vibrate(ms)`: Android/Chrome, Firefox, Samsung Internet. È reale e
 * gratis, ed è quello che il codice qui sotto chiama.
 *
 * ── Cosa NON funziona, e non per distrazione ─────────────────────────────────
 *  1. SU iOS LA VIBRATION API NON È MAI ESISTITA E NON ESISTE ANCORA. caniuse
 *     (`mdn-api_navigator_vibrate`, letto il 07/08/2026) elenca «Safari on iOS
 *     3.2 – 26.5: Not supported», versione per versione fino all'ultima. Su
 *     iPhone la riga qui sotto è quindi un no-op — non un bug, il contratto.
 *
 *  2. IL TRUCCO DELLO SWITCH È MORTO IN iOS 26.5. Da Safari 17.4 il controllo
 *     nativo `<input type="checkbox" switch>` fa suonare al SISTEMA un tick
 *     aptico quando cambia stato, e le librerie del settore (`ios-haptics`,
 *     `web-haptics`) lo sfruttavano facendo `.click()` da JavaScript su una
 *     `<label>` collegata a uno switch nascosto. Apple ha chiuso proprio
 *     QUELL'attivazione programmatica in iOS 26.5:
 *       · github.com/tijnjh/ios-haptics — «only works on ios 17.4 to 26.4, as
 *         apple patched it in ios 26.5»;
 *       · github.com/lochie/web-haptics#41 — «on iOS 26.5+ the haptic seems to
 *         require the user to directly tap the native WebKit switch control
 *         itself. Calling `.click()` from JavaScript is no longer enough.»
 *     Quello che sopravvive su 26.5+ è solo il DITO che tocca uno switch VERO,
 *     renderizzato (`opacity: 0`, mai `display: none`) e con l'aspetto nativo
 *     intatto, sovrapposto al bersaglio.
 *
 *  3. E QUELLA STRADA QUI NON SI PUÒ PERCORRERE, per quattro motivi che si
 *     sommano — il chiamante di `haptic()` è UNO SOLO (`useLongPress`), e quel
 *     gesto non è un tap:
 *       · il momento è sbagliato: la pulsazione deve partire a 500ms DENTRO una
 *         pressione mantenuta, mentre lo switch suona quando il tocco lo attiva;
 *       · il tocco verrebbe rubato: lo switch è sopra la riga, quindi il tap non
 *         arriverebbe più alla chat/tab/tessera sottostante;
 *       · toggla un controllo VERO, con uno stato vero da gestire e da azzerare;
 *       · e mette una checkbox nell'albero di accessibilità di OGNI superficie
 *         che si può tenere premuta (righe chat, tab, progetti, tessere).
 *     Quattro regressioni certe per un tick che su 26.5 non arriverebbe comunque
 *     al momento giusto. Quindi qui NON si crea nessun elemento di servizio: non
 *     c'è niente da nascondere all'albero a11y perché non nasce niente.
 *
 * ── Cosa resta su iPhone ─────────────────────────────────────────────────────
 * Il feedback VISIVO, che c'è già: `useLongPress` alza `pressed` appena il timer
 * parte e i chiamanti lo rendono con `[data-pressing]` (index.css). Non è un
 * ripiego di comodo — è esattamente la ragione per cui quel flag esiste, ed è
 * l'unico segnale che su iOS arriva davvero al dito prima che il menu si apra.
 */

type HapticStrength = 'light' | 'medium' | 'heavy';

/**
 * Durata della pulsazione, in millisecondi. Sono «micro» apposta: sotto i ~10ms
 * molti motori non riescono ad avviarsi, sopra i ~30 non è più un tocco, è un
 * avviso.
 */
const PULSE_MS: Record<HapticStrength, number> = { light: 10, medium: 20, heavy: 30 };

/**
 * Chiede una micro-vibrazione. Restituisce `true` solo se una pulsazione è stata
 * DAVVERO chiesta alla piattaforma — su iPhone è sempre `false`, vedi sopra.
 */
export function haptic(strength: HapticStrength = 'light'): boolean {
  if (typeof navigator === 'undefined') return false;

  // La funzione si legge attraverso un tipo NOSTRO invece di intersecare
  // `Navigator`: lì `vibrate` è dichiarata obbligatoria, e intersecarla con una
  // versione opzionale produce una firma che rifiuta il numero secco
  // («Argument of type 'number' is not assignable to parameter of type
  // 'Iterable<number>'», tsc del 07/08). `navigator.vibrate(20)` è invece
  // esattamente la chiamata che ogni motore accetta.
  const vibrate = (navigator as unknown as { vibrate?: (pattern: number) => unknown }).vibrate;

  // `typeof … === 'function'`, NON `'vibrate' in navigator`: un WebView che
  // dichiara la proprietà senza implementarla passa l'`in` e poi lancia un
  // TypeError alla chiamata. E un throw qui non resterebbe locale — l'unico
  // chiamante è il timer di `useLongPress`, che invoca `haptic('medium')` sulla
  // riga PRIMA di `cbRef.current(…)`: l'eccezione ucciderebbe il callback e il
  // menu contestuale non si aprirebbe più. Cioè il feedback tattile che manca
  // porterebbe via con sé anche il gesto. Per la stessa ragione la chiamata sta
  // in un `try`: qualunque cosa faccia la piattaforma, il menu si apre.
  if (typeof vibrate !== 'function') return false;

  try {
    vibrate.call(navigator, PULSE_MS[strength]);
  } catch {
    return false;
  }
  return true;
}
