/**
 * Quale tastiera per quale campo.
 *
 * Il difetto che questo modulo chiude è che la tastiera usciva SEMPRE uguale —
 * quella di testo — qualunque campo si toccasse. Quindi le prove che contano
 * sono quelle che distinguono: email dà email, numero dà numero, password dà
 * password, e un bottone non dà niente affatto.
 *
 * Niente renderer e niente DOM: jsdom/happy-dom non sono dipendenze di questo
 * progetto (vedi IdentitySection.test.tsx). Gli elementi sono stub minimi che
 * espongono ESATTAMENTE la superficie che il modulo usa — se domani il modulo
 * ne toccasse un'altra, qui esploderebbe invece di mentire. Il comportamento
 * vero del DOM (elementFromPoint sul mirror, il focus, la tastiera) è provato
 * dalla E2E `browser-mobile-keyboard.spec.ts`, che gira in un motore vero.
 *
 * @covers BROWSER-KBD-01
 */
import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_KEYBOARD_PROFILE,
  applyKeyboardProfile,
  keyboardProfileFor,
  resolveFieldElement,
  sameKeyboardProfile,
} from './browserKeyboardProfile';

interface FakeOpts {
  tag: string;
  attrs?: Record<string, string>;
  parent?: FakeEl | null;
  /** Discendenti restituiti da querySelector (primo che combacia, in ordine). */
  children?: FakeEl[];
  /** Antenato `form` visto da closest('form'). */
  inForm?: boolean;
  /** Registro id → elemento, per `<label for>`. */
  byId?: Record<string, FakeEl>;
}

class FakeEl {
  tagName: string;
  private attrs: Record<string, string>;
  parentElement: FakeEl | null;
  private children: FakeEl[];
  private inForm: boolean;
  ownerDocument: { getElementById(id: string): FakeEl | null };

  constructor(o: FakeOpts) {
    this.tagName = o.tag.toUpperCase();
    this.attrs = o.attrs ?? {};
    this.parentElement = o.parent ?? null;
    this.children = o.children ?? [];
    this.inForm = o.inForm ?? false;
    const registry = o.byId ?? {};
    this.ownerDocument = { getElementById: (id: string) => registry[id] ?? null };
  }

  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null;
  }

  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }

  querySelector(): FakeEl | null {
    return this.children[0] ?? null;
  }

  closest(sel: string): FakeEl | null {
    return sel === 'form' && this.inForm ? new FakeEl({ tag: 'form' }) : null;
  }
}

const el = (o: FakeOpts): Element => new FakeEl(o) as unknown as Element;
const input = (attrs: Record<string, string>, extra: Partial<FakeOpts> = {}): Element =>
  el({ tag: 'input', attrs, ...extra });

describe('keyboardProfileFor — la tastiera segue il campo', () => {
  test('un campo email chiede la tastiera email, non quella di testo', () => {
    const p = keyboardProfileFor(input({ type: 'email' }));
    expect(p?.type).toBe('email');
  });

  test('numero, telefono, url e ricerca arrivano ciascuno col proprio tipo', () => {
    expect(keyboardProfileFor(input({ type: 'number' }))?.type).toBe('number');
    expect(keyboardProfileFor(input({ type: 'tel' }))?.type).toBe('tel');
    expect(keyboardProfileFor(input({ type: 'url' }))?.type).toBe('url');
    expect(keyboardProfileFor(input({ type: 'search' }))?.type).toBe('search');
  });

  test('password resta password — è la sola che spegne suggerimenti e maiuscole', () => {
    const p = keyboardProfileFor(input({ type: 'password', autocapitalize: 'words', spellcheck: 'true' }));
    expect(p?.type).toBe('password');
    expect(p?.autoCapitalize).toBe('off');
    expect(p?.autoCorrect).toBe('off');
  });

  test('un input senza type è testo, come vuole HTML', () => {
    expect(keyboardProfileFor(input({}))?.type).toBe('text');
  });

  test('un type che non conosciamo non inventa una tastiera: resta testo', () => {
    expect(keyboardProfileFor(input({ type: 'wat' }))?.type).toBe('text');
  });

  test('`inputmode` vince sul `type`: è la dichiarazione fatta apposta per la tastiera', () => {
    const p = keyboardProfileFor(input({ type: 'text', inputmode: 'decimal' }));
    expect(p?.inputMode).toBe('decimal');
  });

  test('un `inputmode` inventato si scarta invece di essere inoltrato', () => {
    expect(keyboardProfileFor(input({ type: 'text', inputmode: 'numerico' }))?.inputMode).toBe('');
  });

  test('un campo dentro un form dice «vai» sul tasto invio; la ricerca dice «cerca»', () => {
    expect(keyboardProfileFor(input({ type: 'text' }, { inForm: true }))?.enterKeyHint).toBe('go');
    expect(keyboardProfileFor(input({ type: 'search' }, { inForm: true }))?.enterKeyHint).toBe('search');
  });

  test('un `enterkeyhint` esplicito del sito vince sul nostro indovinello', () => {
    expect(keyboardProfileFor(input({ type: 'text', enterkeyhint: 'send' }, { inForm: true }))?.enterKeyHint).toBe('send');
  });

  test('la textarea è testo e NON si prende il «vai»: lì invio va a capo', () => {
    const p = keyboardProfileFor(el({ tag: 'textarea', inForm: true }));
    expect(p?.type).toBe('text');
    expect(p?.enterKeyHint).toBe('');
  });

  test('un contenteditable è scrittura a tutti gli effetti', () => {
    expect(keyboardProfileFor(el({ tag: 'div', attrs: { contenteditable: 'true' } }))?.type).toBe('text');
  });
});

describe('keyboardProfileFor — quando NON deve salire nessuna tastiera', () => {
  test('bottoni, checkbox, radio, file e affini: niente', () => {
    for (const type of ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'hidden']) {
      expect(keyboardProfileFor(input({ type }))).toBeNull();
    }
  });

  test('i campi data aprono un rullo, non una tastiera: meglio tacere che fingere', () => {
    for (const type of ['date', 'time', 'month', 'week', 'datetime-local']) {
      expect(keyboardProfileFor(input({ type }))).toBeNull();
    }
  });

  test('una select apre la sua lista', () => {
    expect(keyboardProfileFor(el({ tag: 'select' }))).toBeNull();
  });

  test('disabilitato o in sola lettura: iOS la tastiera non la apre, e nemmeno noi', () => {
    expect(keyboardProfileFor(input({ type: 'text', disabled: '' }))).toBeNull();
    expect(keyboardProfileFor(input({ type: 'text', readonly: '' }))).toBeNull();
  });

  test('toccare il vuoto della pagina non è toccare un campo', () => {
    expect(keyboardProfileFor(el({ tag: 'div' }))).toBeNull();
    expect(keyboardProfileFor(null)).toBeNull();
  });
});

describe('resolveFieldElement — il dito non atterra sull\'input', () => {
  test('sale dal figlio decorativo al campo che lo contiene', () => {
    const field = input({ type: 'email' });
    const icon = el({ tag: 'span', parent: el({ tag: 'div', parent: field as unknown as FakeEl }) as unknown as FakeEl });
    expect(keyboardProfileFor(icon)?.type).toBe('email');
  });

  test('una label con `for` porta al suo campo', () => {
    const field = new FakeEl({ tag: 'input', attrs: { type: 'tel' } });
    const label = el({ tag: 'label', attrs: { for: 'phone' }, byId: { phone: field } });
    expect(keyboardProfileFor(label)?.type).toBe('tel');
  });

  test('una label che avvolge il campo lo trova dentro di sé', () => {
    const field = new FakeEl({ tag: 'input', attrs: { type: 'number' } });
    const label = el({ tag: 'label', children: [field] });
    expect(keyboardProfileFor(label)?.type).toBe('number');
  });

  test('una label che non porta a nessun campo si ferma lì, non risale oltre', () => {
    // Senza questo taglio si risalirebbe fino a un <form> qualunque e si
    // aprirebbe una tastiera per un'etichetta che non scrive niente.
    expect(resolveFieldElement(el({ tag: 'label' }))).toBeNull();
  });

  test('non risale all\'infinito: oltre una manciata di salti si arrende', () => {
    let node = new FakeEl({ tag: 'div' });
    for (let i = 0; i < 20; i++) node = new FakeEl({ tag: 'div', parent: node });
    const field = new FakeEl({ tag: 'input', attrs: { type: 'email' } });
    // La catena è lunga: il campo in cima non deve essere raggiunto.
    let cursor: FakeEl = node;
    while (cursor.parentElement) cursor = cursor.parentElement;
    cursor.parentElement = field;
    expect(resolveFieldElement(node as unknown as Element)).toBeNull();
  });
});

describe('applyKeyboardProfile — si scrive sul campo di cattura', () => {
  /** Stub del solo <input> nascosto: gli attributi che iOS legge al focus. */
  function fakeCapture() {
    const set: Record<string, string> = {};
    return {
      type: 'text',
      inputMode: '',
      enterKeyHint: '',
      spellcheck: false,
      autocomplete: '',
      setAttribute(k: string, v: string) { set[k] = v; },
      attrs: set,
    };
  }

  test('trasferisce tipo, modo, invio e correttore', () => {
    const cap = fakeCapture();
    const profile = keyboardProfileFor(input({ type: 'email', enterkeyhint: 'send' }))!;
    applyKeyboardProfile(cap as unknown as HTMLInputElement, profile);
    expect(cap.type).toBe('email');
    expect(cap.enterKeyHint).toBe('send');
    expect(cap.attrs.autocorrect).toBe('off');
    expect(cap.spellcheck).toBe(false);
  });

  test('l\'autocompletamento resta spento: il campo di cattura non è un modulo', () => {
    const cap = fakeCapture();
    applyKeyboardProfile(cap as unknown as HTMLInputElement, DEFAULT_KEYBOARD_PROFILE);
    expect(cap.autocomplete).toBe('off');
  });
});

/**
 * Il confronto fra due profili esiste per una ragione sola: quando il server
 * riporta il campo a fuoco DOPO che il mirror aveva già vestito la cattura, la
 * risposta di solito conferma. Rifare il fuoco per confermare farebbe
 * sfarfallare la tastiera aperta, quindi prima si guarda se cambia qualcosa.
 */
describe('sameKeyboardProfile', () => {
  test('due profili uguali non chiedono nessun cambio di tastiera', () => {
    const a = keyboardProfileFor(input({ type: 'email' }))!;
    const b = keyboardProfileFor(input({ type: 'email' }))!;
    expect(sameKeyboardProfile(a, b)).toBe(true);
  });

  test('un tipo diverso è un cambio di tastiera', () => {
    const a = keyboardProfileFor(input({ type: 'email' }))!;
    const b = keyboardProfileFor(input({ type: 'tel' }))!;
    expect(sameKeyboardProfile(a, b)).toBe(false);
  });

  test('anche solo il tasto invio conta: è una tastiera diversa sotto le dita', () => {
    const a = keyboardProfileFor(input({ type: 'text', enterkeyhint: 'send' }))!;
    const b = keyboardProfileFor(input({ type: 'text' }))!;
    expect(sameKeyboardProfile(a, b)).toBe(false);
  });

  test('nessun profilo contro un profilo: mai «uguale»', () => {
    const a = keyboardProfileFor(input({ type: 'email' }))!;
    expect(sameKeyboardProfile(null, a)).toBe(false);
    expect(sameKeyboardProfile(a, null)).toBe(false);
    expect(sameKeyboardProfile(null, null)).toBe(true);
  });
});
