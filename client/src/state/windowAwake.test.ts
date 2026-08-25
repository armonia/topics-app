/**
 * @covers RUNTIME-11
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isWindowAwake } from './windowAwake';
import { markBrowserViewDead, markBrowserViewLive } from '../lib/shell/nativeBrowserRoster';

/**
 * `isWindowAwake` decide se poll, rAF e observer di mezza app girano o dormono.
 * Se sbaglia in un verso si brucia CPU per un'immagine che nessuno guarda; se
 * sbaglia nell'altro l'app si ferma mentre la stai usando. Vale i sei test che
 * costa.
 */

const real = {
  document: (globalThis as { document?: unknown }).document,
};

function stubDocument(over: { hidden?: boolean; hasFocus?: unknown }): void {
  (globalThis as { document?: unknown }).document = {
    hidden: over.hidden ?? false,
    ...(('hasFocus' in over) ? { hasFocus: over.hasFocus } : {}),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeEach(() => {
  stubDocument({ hidden: false, hasFocus: () => true });
});

afterEach(() => {
  if (real.document === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = real.document;
});

describe('isWindowAwake', () => {
  test('finestra visibile e a fuoco: sveglia', () => {
    expect(isWindowAwake()).toBe(true);
  });

  test('documento nascosto: dorme', () => {
    stubDocument({ hidden: true, hasFocus: () => true });
    expect(isWindowAwake()).toBe(false);
  });

  test("visibile ma DIETRO un'altra app: dorme", () => {
    // È il caso che `document.hidden` da solo non vede, e per cui esiste questo
    // modulo: la finestra è sullo schermo, ma davanti c'è un'altra app.
    stubDocument({ hidden: false, hasFocus: () => false });
    expect(isWindowAwake()).toBe(false);
  });

  test('senza `hasFocus` fallisce APERTO', () => {
    // Embedder vecchi e doppioni nei test. Un poll che smette di girare in
    // silenzio è peggio di uno che gira di troppo: il primo è un bug che nessuno
    // vede, il secondo è una riga in un profilo.
    stubDocument({ hidden: false });
    expect(isWindowAwake()).toBe(true);
  });

  test('senza `document` (SSR, worker) fallisce APERTO', () => {
    delete (globalThis as { document?: unknown }).document;
    expect(isWindowAwake()).toBe(true);
  });

  test("con una webview FIGLIA viva, hasFocus()=false non conta piu'", () => {
    // Un click dentro una pane browser nativa rende key la figlia: il documento
    // ospite legge false ESATTAMENTE mentre l'utente sta usando l'app. Senza
    // questo ramo, tutti i terminali visibili precipitavano da 15 Hz a 4.
    stubDocument({ hidden: false, hasFocus: () => false });
    expect(isWindowAwake()).toBe(false);
    markBrowserViewLive('pane-browser-1');
    try {
      expect(isWindowAwake()).toBe(true);
    } finally {
      markBrowserViewDead('pane-browser-1');
    }
    expect(isWindowAwake()).toBe(false);
  });

  test('una figlia viva NON sovrascrive il documento nascosto', () => {
    // Nascosto resta il segnale forte: minimizzata o in un altro Spazio, non la
    // guarda nessuno per davvero, figlie o no.
    stubDocument({ hidden: true, hasFocus: () => false });
    markBrowserViewLive('pane-browser-2');
    try {
      expect(isWindowAwake()).toBe(false);
    } finally {
      markBrowserViewDead('pane-browser-2');
    }
  });

  test('nascosto vince su a-fuoco', () => {
    // Combinazione contraddittoria, possibile durante una transizione: nascosto
    // è il segnale più forte.
    stubDocument({ hidden: true, hasFocus: () => true });
    expect(isWindowAwake()).toBe(false);
  });
});
