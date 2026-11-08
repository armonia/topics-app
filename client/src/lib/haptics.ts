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
 *  2b. MA FINO A 26.4 IL CLICK PROGRAMMATICO FUNZIONA, ed è quello che facciamo.
 *     La patch di 26.5 riguarda `.click()` da JavaScript; su iOS 17.4 → 26.4 lo
 *     stesso click fa suonare il Taptic Engine, e in quel caso NON servono né un
 *     overlay né un tocco vero: basta uno switch nascosto e inerte, cliccato dal
 *     codice. Non c'è modo di sapere da qui su che versione gira un iPhone, e
 *     nemmeno di rilevare se il tick è uscito — ma il costo di provarci è zero:
 *     dove la piattaforma risponde, Attilio sente la vibrazione che ha chiesto;
 *     dove Apple ha chiuso, il click cade nel vuoto e resta il feedback visivo.
 *     Rinunciare a priori avrebbe tolto la funzione anche a chi ce l'ha.
 *
 *  3. QUELLO CHE NON SI FA È L'OVERLAY, per quattro motivi che si
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
 *     al momento giusto. L'elemento che creiamo al punto 2b è l'opposto: uno
 *     solo per tutta l'app, inerte, fuori dallo schermo e fuori dall'albero di
 *     accessibilità, che nessun dito tocca mai.
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
/**
 * Lo switch di servizio per iOS, creato UNA volta e mai più.
 *
 * Regole che lo tengono innocuo, tutte necessarie:
 *  · `aria-hidden` + `tabIndex = -1` → non entra nell'albero di accessibilità né
 *    nel giro del Tab: uno screen reader non annuncerà mai una casella fantasma.
 *  · fuori schermo e `pointer-events: none` → nessun dito può toccarlo, quindi
 *    non ruba un tocco a nessuna superficie sottostante.
 *  · `opacity: 0`, MAI `display: none` né `visibility: hidden`: un controllo non
 *    renderizzato non fa suonare niente — è il dettaglio su cui si arenano le
 *    implementazioni ingenue.
 *  · nessun `name`, mai dentro un form → non finisce in nessun invio.
 */
let iosSwitch: HTMLInputElement | null = null;
let iosLabel: HTMLLabelElement | null = null;

/** Solo per i test: dimentica gli elementi creati, così ogni caso riparte pulito. */
export function __resetHaptics(): void { iosSwitch = null; iosLabel = null; }

function iosHapticSwitch(): HTMLLabelElement | null {
  // Capability, non esistenza: nei test `document` può essere uno stub
  // parziale (solo querySelector) — l'esistenza non implica createElement. E
  // `body` non è garantito nemmeno in un browser vero: uno script in `<head>`
  // gira prima che esista, e lì l'appendChild qui sotto lancerebbe.
  if (typeof document === 'undefined' || typeof document.createElement !== 'function' || !document.body) return null;
  if (iosLabel?.isConnected && iosSwitch?.isConnected) return iosLabel;

  const el = document.createElement('input');
  el.type = 'checkbox';
  // L'attributo che rende il controllo uno SWITCH nativo (Safari 17.4+): è
  // quello, non la checkbox, ad avere il tick di sistema. Si scrive come
  // attributo perché non esiste nella tipizzazione di HTMLInputElement.
  el.setAttribute('switch', '');
  el.setAttribute('aria-hidden', 'true');
  el.id = 'topics-haptic-switch';
  el.tabIndex = -1;
  el.style.cssText =
    'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';

  // SI CLICCA LA LABEL, NON L'INPUT — ed è la differenza fra sentire e non
  // sentire. Le librerie che questa tecnica l'hanno provata sul campo
  // (`ios-haptics`, `web-haptics`) cliccano una `<label for=…>` legata allo
  // switch, e la nota della patch di Apple lo dice in tutte lettere: «you can no
  // longer trigger haptic feedback programmatically by calling .click() on a
  // <label> that is for an <input type="checkbox" switch />». Cioè: fino a 26.4
  // è QUEL percorso — attivazione per label — a far suonare il motore; un
  // `.click()` sull'input cambia lo stato senza passare di lì. Al primo giro
  // avevo cliccato l'input, e non si sentiva niente.
  const lab = document.createElement('label');
  lab.htmlFor = el.id;
  lab.setAttribute('aria-hidden', 'true');
  lab.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;';

  document.body.appendChild(el);
  document.body.appendChild(lab);
  iosSwitch = el;
  iosLabel = lab;
  return lab;
}

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
  if (typeof vibrate !== 'function') {
    // Nessuna Vibration API: se siamo su iOS si tenta lo switch. Su 17.4–26.4
    // esce un tick vero; da 26.5 il click cade nel vuoto e non succede niente —
    // in entrambi i casi nessun effetto collaterale, e il gesto prosegue.
    return iosSwitchPulse();
  }

  try {
    vibrate.call(navigator, PULSE_MS[strength]);
  } catch {
    return false;
  }
  return true;
}

/**
 * Il tick di iOS. Restituisce `true` quando il click è stato EMESSO — non quando
 * il motore ha suonato: quello il web non può saperlo, e dichiararlo sarebbe una
 * bugia comoda. Su 26.5+ questa funzione torna `true` e non si sente niente, ed
 * è il massimo di verità che la piattaforma concede.
 */
function iosSwitchPulse(): boolean {
  // Solo su iOS: altrove non c'è nessun tick da ottenere, e un elemento in più
  // nel DOM di ogni desktop sarebbe peso senza contropartita.
  if (!/iPhone|iPad|iPod/.test(navigator.userAgent)) return false;
  const lab = iosHapticSwitch();
  if (!lab) return false;
  try {
    // Il click sulla LABEL attiva lo switch per la strada che il sistema
    // riconosce (vedi il commento in `iosHapticSwitch`). Lo stato si rimette a
    // riposo subito: nessuno lo legge — lo switch non ha né `name` né form — ma
    // lasciarlo alternato sarebbe uno stato sporco che prima o poi qualcuno
    // leggerebbe.
    lab.click();
    if (iosSwitch) iosSwitch.checked = false;
  } catch {
    return false;
  }
  return true;
}
