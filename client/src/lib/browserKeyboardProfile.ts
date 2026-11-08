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
 * Questo modulo è la META' che parla col DOM: dal nodo sotto il dito risale al
 * campo vero e ne fotografa gli attributi. La DECISIONE (quali attributi, quale
 * tastiera) sta in `shared/browser-keyboard-field.ts`, perché la stessa domanda
 * arriva anche dal server: sul ramo video non c'è nessun mirror da interrogare,
 * e il descrittore del campo a fuoco viaggia sul WS del pane. Una tabella sola,
 * due strade per riempirla.
 */
import {
  DEFAULT_KEYBOARD_PROFILE,
  keyboardProfileForField,
  type KeyboardProfile,
  type RemoteField,
} from '../../../shared/browser-keyboard-field';

export {
  DEFAULT_KEYBOARD_PROFILE,
  keyboardProfileForField,
  type KeyboardProfile,
  type RemoteField,
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
 * Gli attributi che decidono la tastiera, letti da un elemento del mirror.
 * È la stessa forma che il server manda sul WS: da qui in poi la decisione è
 * una sola funzione condivisa.
 */
export function fieldFromElement(el: Element): RemoteField {
  const tag = el.tagName?.toLowerCase() || '';
  return {
    tag,
    type: tag === 'input' ? attr(el, 'type') : '',
    inputMode: attr(el, 'inputmode'),
    enterKeyHint: attr(el, 'enterkeyhint'),
    autoCapitalize: attr(el, 'autocapitalize'),
    autoCorrect: attr(el, 'autocorrect'),
    spellCheck: attr(el, 'spellcheck'),
    disabled: el.hasAttribute('disabled'),
    readOnly: el.hasAttribute('readonly'),
    inForm: !!el.closest?.('form'),
  };
}

/**
 * Il profilo di tastiera del campo remoto sotto il nodo toccato, oppure `null`
 * se toccare quel punto non deve aprire nessuna tastiera.
 */
export function keyboardProfileFor(target: Element | null): KeyboardProfile | null {
  const el = resolveFieldElement(target);
  if (!el) return null;
  return keyboardProfileForField(fieldFromElement(el));
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

/**
 * Due profili che vestono la stessa tastiera? Serve a NON rifare il fuoco
 * quando la risposta del server conferma ciò che il mirror aveva già detto: un
 * cambio di fuoco inutile, a tastiera aperta, la fa sfarfallare.
 */
export function sameKeyboardProfile(a: KeyboardProfile | null, b: KeyboardProfile | null): boolean {
  if (!a || !b) return a === b;
  return a.type === b.type
    && a.inputMode === b.inputMode
    && a.enterKeyHint === b.enterKeyHint
    && a.autoCapitalize === b.autoCapitalize
    && a.autoCorrect === b.autoCorrect;
}
