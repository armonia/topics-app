/**
 * La tastiera decisa su un descrittore che arriva dal filo.
 *
 * `browserKeyboardProfile.test.ts` prova la stessa tabella partendo da elementi
 * del mirror. Questa prova l'altra strada, quella che sul ramo video è l'UNICA:
 * il server legge `document.activeElement` nella pagina vera, ne manda gli
 * attributi, e il pane deve arrivare alla stessa tastiera. Le due strade si
 * incontrano qui, in `keyboardProfileForField`.
 *
 * Quindi le prove che contano sono le stesse di là: email dà email, un
 * `inputmode` dichiarato batte il `type`, e un bottone non dà niente affatto.
  * @covers KBDFIELD-01
 */
import { describe, test, expect } from 'bun:test';
import { keyboardProfileForField, type RemoteField } from './browser-keyboard-field';

/** Un descrittore come lo manda il server (solo il `tag` è obbligatorio). */
function field(over: Partial<RemoteField> & { tag: string }): RemoteField {
  return over;
}

describe('keyboardProfileForField: il tipo del campo remoto sceglie la tastiera', () => {
  test('un input senza type è testo', () => {
    expect(keyboardProfileForField(field({ tag: 'input' }))?.type).toBe('text');
  });

  test('email, tel, number, url, search e password passano ognuno il suo', () => {
    for (const t of ['email', 'tel', 'number', 'url', 'search', 'password']) {
      expect(keyboardProfileForField(field({ tag: 'input', type: t }))?.type).toBe(t as never);
    }
  });

  test('un type sconosciuto non inventa niente: resta testo', () => {
    // Il server manda l'ATTRIBUTO, non la proprietà normalizzata: qui arriva
    // esattamente ciò che c'è scritto nel sorgente della pagina.
    expect(keyboardProfileForField(field({ tag: 'input', type: 'fantasia' }))?.type).toBe('text');
  });

  test('una textarea e un contenteditable sono testo', () => {
    expect(keyboardProfileForField(field({ tag: 'textarea' }))?.type).toBe('text');
    expect(keyboardProfileForField(field({ tag: 'div' }))?.type).toBe('text');
  });
});

describe('keyboardProfileForField: dove NON deve salire nessuna tastiera', () => {
  test('niente campo, niente tastiera', () => {
    expect(keyboardProfileForField(null)).toBeNull();
    expect(keyboardProfileForField(undefined)).toBeNull();
  });

  test('bottoni, checkbox e affini', () => {
    for (const t of ['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'color', 'hidden', 'image']) {
      expect(keyboardProfileForField(field({ tag: 'input', type: t }))).toBeNull();
    }
  });

  test('i campi data aprono un rullo, non una tastiera', () => {
    for (const t of ['date', 'datetime-local', 'month', 'week', 'time']) {
      expect(keyboardProfileForField(field({ tag: 'input', type: t }))).toBeNull();
    }
  });

  test('una select apre la sua lista', () => {
    expect(keyboardProfileForField(field({ tag: 'select' }))).toBeNull();
  });

  test('disabilitato o in sola lettura: iOS la tastiera non la apre', () => {
    expect(keyboardProfileForField(field({ tag: 'input', type: 'text', disabled: true }))).toBeNull();
    expect(keyboardProfileForField(field({ tag: 'input', type: 'email', readOnly: true }))).toBeNull();
  });
});

describe('keyboardProfileForField: inputmode e tasto invio', () => {
  test('un inputmode dichiarato vince sul type (il campo OTP)', () => {
    const p = keyboardProfileForField(field({ tag: 'input', type: 'text', inputMode: 'numeric' }));
    expect(p?.inputMode).toBe('numeric');
  });

  test('un inputmode fuori specifica si ignora, non si inoltra', () => {
    expect(keyboardProfileForField(field({ tag: 'input', inputMode: 'numerico' }))?.inputMode).toBe('');
  });

  test('enterkeyhint dichiarato si rispetta', () => {
    expect(keyboardProfileForField(field({ tag: 'input', enterKeyHint: 'send' }))?.enterKeyHint).toBe('send');
    expect(keyboardProfileForField(field({ tag: 'input', enterKeyHint: 'invia' }))?.enterKeyHint).toBe('');
  });

  test('dentro un form, senza dichiarazioni, l’invio manda', () => {
    expect(keyboardProfileForField(field({ tag: 'input', inForm: true }))?.enterKeyHint).toBe('go');
    expect(keyboardProfileForField(field({ tag: 'input', type: 'search', inForm: true }))?.enterKeyHint).toBe('search');
    // In una textarea l'invio va a capo: non è un tasto che manda.
    expect(keyboardProfileForField(field({ tag: 'textarea', inForm: true }))?.enterKeyHint).toBe('');
  });

  test('fuori da un form non si promette niente', () => {
    expect(keyboardProfileForField(field({ tag: 'input' }))?.enterKeyHint).toBe('');
  });
});

describe('keyboardProfileForField: maiuscole e correttore', () => {
  test('le dichiarazioni del sito si seguono', () => {
    const p = keyboardProfileForField(field({ tag: 'input', autoCapitalize: 'words', spellCheck: 'true' }));
    expect(p?.autoCapitalize).toBe('words');
    expect(p?.autoCorrect).toBe('on');
  });

  test('`none` e `off` sono la stessa cosa per il campo di cattura', () => {
    expect(keyboardProfileForField(field({ tag: 'input', autoCapitalize: 'none' }))?.autoCapitalize).toBe('off');
  });

  test('su email, url e password il correttore resta zitto comunque', () => {
    for (const t of ['email', 'url', 'password']) {
      const p = keyboardProfileForField(field({ tag: 'input', type: t, autoCapitalize: 'words', autoCorrect: 'on' }));
      expect(p?.autoCapitalize).toBe('off');
      expect(p?.autoCorrect).toBe('off');
    }
  });
});

describe('keyboardProfileForField: quello che arriva dal filo è grezzo', () => {
  test('maiuscole e spazi negli attributi non cambiano la risposta', () => {
    const p = keyboardProfileForField(field({ tag: 'INPUT', type: ' EMAIL ', enterKeyHint: 'GO' }));
    expect(p?.type).toBe('email');
    expect(p?.enterKeyHint).toBe('go');
  });

  test('un descrittore vuoto di tutto resta la tastiera di testo', () => {
    expect(keyboardProfileForField(field({ tag: 'input', type: '', inputMode: '', enterKeyHint: '' }))).toEqual({
      type: 'text',
      inputMode: '',
      enterKeyHint: '',
      autoCapitalize: 'off',
      autoCorrect: 'off',
    });
  });
});
