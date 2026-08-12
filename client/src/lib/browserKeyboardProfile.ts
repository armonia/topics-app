/**
 * Quale tastiera deve uscire quando tocchi un campo nel pane browser.
 *
 * Il problema, dal telefono (Attilio, 12/08): «clicco un campo e mi esce una
 * tastiera a caso». Non è casuale, è SEMPRE la stessa — quella di testo. Nel
 * co-browse DOM la pagina remota è un mirror non interattivo: il campo che
 * riceve davvero il focus di iOS è un elemento di cattura NOSTRO, nascosto, e
 * finora era una <textarea> nuda. iOS sceglie la tastiera guardando quello, non
 * il campo che hai toccato — quindi email, numero e password davano tutti la
 * tastiera di testo.
 *
 * Qui si estrae dal campo remoto il profilo di tastiera e lo si copia sul campo
 * di cattura PRIMA di dargli il focus: iOS legge gli attributi al momento del
 * focus, cambiarli dopo non aggiorna la tastiera già aperta.
 *
 * Sta in un modulo suo, senza React e senza DOM del pane, perché è la sola
 * parte con una risposta giusta e una sbagliata: si misura a tavolino.
 */

/** I `type` di input che chiedono una tastiera diversa. Tutto il resto → testo. */
const KEYBOARD_TYPES = new Set(['text', 'email', 'url', 'tel', 'number', 'search', 'password']);

/** `inputmode` validi per HTML — un valore fuori lista si ignora, non si inoltra. */
const INPUT_MODES = new Set(['none', 'text', 'decimal', 'numeric', 'tel', 'search', 'email', 'url']);

/** `enterkeyhint` validi — decidono la parola sul tasto invio (Vai, Cerca, Invia…). */
const ENTER_HINTS = new Set(['enter', 'done', 'go', 'next', 'previous', 'search', 'send']);

const CAPITALIZE = new Set(['off', 'none', 'on', 'sentences', 'words', 'characters']);

/**
 * Gli `type` che NON sono scrittura: toccarli non deve far salire nessuna
 * tastiera. Prima ne saliva una per ogni tocco — anche sul bottone «Cerca».
 */
const NON_TEXT_TYPES = new Set([
  'button', 'submit', 'reset', 'image', 'file', 'checkbox', 'radio', 'range',
  'color', 'hidden',
]);

/**
 * I `type` data/ora: su iOS aprono un rullo, non una tastiera. Non li possiamo
 * riprodurre su un campo di cattura, e fingere una tastiera numerica sarebbe
 * peggio del silenzio — quindi contano come non-scrittura.
 */
const PICKER_TYPES = new Set(['date', 'datetime-local', 'month', 'week', 'time']);

export interface KeyboardProfile {
  /** `type` da mettere sul campo di cattura. */
  type: 'text' | 'email' | 'url' | 'tel' | 'number' | 'search' | 'password';
  /** `inputmode`, quando il campo remoto ne dichiara uno (vince sul `type`). */
  inputMode: string;
  /** Parola sul tasto invio. */
  enterKeyHint: string;
  autoCapitalize: string;
  autoCorrect: 'on' | 'off';
}

/** Il profilo di partenza: tastiera di testo, niente correzioni automatiche. */
export const DEFAULT_KEYBOARD_PROFILE: KeyboardProfile = {
  type: 'text',
  inputMode: '',
  enterKeyHint: '',
  autoCapitalize: 'off',
  autoCorrect: 'off',
};

/** Attributo in minuscolo e senza spazi, o stringa vuota se assente. */
function attr(el: Element, name: string): string {
  return (el.getAttribute(name) || '').trim().toLowerCase();
}

/**
 * Dal nodo toccato al campo che scrive davvero.
 *
 * Il dito non atterra quasi mai sull'<input>: prende l'etichetta, il div che lo
 * incornicia, l'icona dentro il bordo. Quindi si sale (il campo che contiene il
 * punto), si segue `<label for>` e si scende in un `<label>` che avvolge il
 * proprio controllo — le tre forme in cui i siti veri scrivono un campo.
 */
export function resolveFieldElement(target: Element | null): Element | null {
  let el: Element | null = target;
  for (let hops = 0; el && hops < 8; hops++) {
    const tag = el.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return el;
    if (el.getAttribute?.('contenteditable') === '' || attr(el, 'contenteditable') === 'true') return el;
    if (tag === 'label') {
      const doc = el.ownerDocument;
      const forId = el.getAttribute('for');
      // `for` vince, com'è nella specifica; poi il controllo annidato.
      const bound = forId && doc ? doc.getElementById(forId) : null;
      const nested = bound || el.querySelector('input, textarea, select, [contenteditable]');
      if (nested) return nested;
      return null;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Il profilo di tastiera del campo remoto, oppure `null` se toccare quel punto
 * non deve aprire nessuna tastiera (un bottone, una checkbox, un rullo data,
 * un campo disabilitato o in sola lettura, o niente affatto).
 */
export function keyboardProfileFor(target: Element | null): KeyboardProfile | null {
  const el = resolveFieldElement(target);
  if (!el) return null;
  const tag = el.tagName?.toLowerCase();
  // Una <select> apre la sua lista, non una tastiera; e un campo che non accetta
  // scrittura non deve chiamarla. `readonly` conta: iOS la tastiera non la apre.
  if (tag === 'select') return null;
  if (el.hasAttribute('disabled') || el.hasAttribute('readonly')) return null;

  const rawType = tag === 'input' ? (attr(el, 'type') || 'text') : 'text';
  if (NON_TEXT_TYPES.has(rawType) || PICKER_TYPES.has(rawType)) return null;

  const profile: KeyboardProfile = { ...DEFAULT_KEYBOARD_PROFILE };
  if (KEYBOARD_TYPES.has(rawType)) profile.type = rawType as KeyboardProfile['type'];

  // `inputmode` è la dichiarazione più precisa che un sito possa fare (è nata
  // apposta per la tastiera) e vince sul `type` quando c'è.
  const mode = attr(el, 'inputmode');
  if (INPUT_MODES.has(mode)) profile.inputMode = mode;

  const hint = attr(el, 'enterkeyhint');
  if (ENTER_HINTS.has(hint)) profile.enterKeyHint = hint;
  else if (tag !== 'textarea' && el.closest?.('form')) {
    // Un campo dentro un form: l'invio manda. È quello che il tasto deve dire.
    profile.enterKeyHint = profile.type === 'search' ? 'search' : 'go';
  }

  // Maiuscole e correttore: si seguono le dichiarazioni del sito, ma solo dove
  // hanno senso. Su email/url/password la correzione automatica storpia il
  // valore, e nessun sito la vuole davvero.
  const quiet = profile.type === 'email' || profile.type === 'url' || profile.type === 'password';
  const cap = attr(el, 'autocapitalize');
  if (!quiet && CAPITALIZE.has(cap)) profile.autoCapitalize = cap === 'none' ? 'off' : cap;
  if (!quiet && attr(el, 'autocorrect') === 'on') profile.autoCorrect = 'on';
  if (!quiet && attr(el, 'spellcheck') === 'true') profile.autoCorrect = 'on';

  return profile;
}

/**
 * Scrive il profilo sul campo di cattura. Va chiamata PRIMA del focus: iOS
 * fotografa gli attributi quando la tastiera sale, e cambiarli a tastiera
 * aperta non la aggiorna.
 */
export function applyKeyboardProfile(el: HTMLInputElement, profile: KeyboardProfile): void {
  // `type` per ultimo no: assegnarlo azzera il valore su alcuni motori, e il
  // campo di cattura va comunque svuotato a ogni battuta.
  if (el.type !== profile.type) el.type = profile.type;
  el.inputMode = profile.inputMode;
  el.enterKeyHint = profile.enterKeyHint;
  el.setAttribute('autocapitalize', profile.autoCapitalize);
  // `autocorrect` è un attributo di Safari, non sta nell'interfaccia DOM.
  el.setAttribute('autocorrect', profile.autoCorrect);
  el.spellcheck = profile.autoCorrect === 'on';
  // Mai riempire il menu di autocompletamento con quel che si scrive altrove —
  // e su password mai proporre il portachiavi per un campo che non è suo.
  el.autocomplete = 'off';
}
