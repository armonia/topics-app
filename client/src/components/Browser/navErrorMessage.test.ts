/**
 * What the pane says when a navigation fails: who did not answer and why, a
 * dead loopback port told apart from a real host, and an unknown code that
 * keeps the engine's own words instead of hiding them.
 *
 * @covers BROWSER-01
 */
import { describe, expect, test } from 'bun:test';
import { deadLoopbackNotice, isLoopbackUrl, navErrorMessage } from './navErrorMessage';

describe('navErrorMessage', () => {
  test('porta locale spenta: dice CHI non risponde e che nessuno è in ascolto', () => {
    const t = navErrorMessage({
      url: 'http://localhost:3210/login',
      description: 'Could not connect to the server.',
      code: -1004,
    });
    expect(t.message).toContain('localhost:3210');
    expect(t.message).toContain('nessun server in ascolto');
    // La frase di Cocoa non deve sopravvivere: è quella che non si capiva.
    expect(t.message).not.toContain('Could not connect');
  });

  test('la porta locale spiega anche PERCHÉ, che è quasi sempre un anteprima morta', () => {
    const t = navErrorMessage({ url: 'http://127.0.0.1:8791/report.html', description: '', code: -1004 });
    expect(t.message).toContain('127.0.0.1:8791');
    expect(t.hint).toContain('anteprima');
  });

  test('stesso codice su un host vero: nessuna storia sulle anteprime', () => {
    const t = navErrorMessage({ url: 'https://example.com/x', description: 'Could not connect.', code: -1004 });
    expect(t.message).toBe('example.com non accetta la connessione.');
    expect(t.hint).toBeUndefined();
  });

  test('host inesistente, timeout e rete assente hanno frasi proprie', () => {
    expect(navErrorMessage({ url: 'https://nope.invalid/', description: '', code: -1003 }).message)
      .toContain('Indirizzo non trovato');
    expect(navErrorMessage({ url: 'https://slow.example/', description: '', code: -1001 }).message)
      .toContain('non ha risposto in tempo');
    expect(navErrorMessage({ url: 'https://x.example/', description: '', code: -1009 }).message)
      .toBe('Nessuna connessione a internet.');
  });

  test('TLS: la frase è nostra, il dettaglio di WebKit resta come seconda riga', () => {
    const t = navErrorMessage({
      url: 'https://self-signed.example/',
      description: 'The certificate for this server is invalid.',
      code: -1202,
    });
    expect(t.message).toContain('certificato non valido');
    expect(t.hint).toBe('The certificate for this server is invalid.');
  });

  test('un codice sconosciuto tiene le parole di WebKit invece di nasconderle', () => {
    const t = navErrorMessage({ url: 'https://x.example/', description: 'Something odd happened.', code: -9999 });
    expect(t).toEqual({ message: 'Something odd happened.' });
  });

  test('senza descrizione e senza URL leggibile resta almeno il codice', () => {
    expect(navErrorMessage({ url: '', description: '', code: -1004 }).message)
      .toBe('Caricamento fallito (codice -1004)');
  });
});

describe('deadLoopbackNotice', () => {
  test('dice chi non risponde e a che ora l\'abbiamo controllato', () => {
    const t = deadLoopbackNotice('http://localhost:3210/login', new Date(2026, 7, 5, 16, 3));
    expect(t.message).toContain('localhost:3210');
    expect(t.hint).toContain('Controllato alle 16:03');
    expect(t.hint).toContain('anteprima');
  });

  test('l\'ora cambia fra due controlli: è il segnale che «Riprova» ha fatto qualcosa', () => {
    const a = deadLoopbackNotice('http://localhost:3210/', new Date(2026, 7, 5, 9, 5));
    const b = deadLoopbackNotice('http://localhost:3210/', new Date(2026, 7, 5, 9, 6));
    expect(a.hint).toContain('09:05');
    expect(b.hint).toContain('09:06');
    expect(a.hint).not.toBe(b.hint);
  });
});

describe('isLoopbackUrl', () => {
  test('riconosce le forme di «questa macchina»', () => {
    for (const u of ['http://localhost:1/', 'http://127.0.0.1/', 'http://[::1]:5/', 'http://app.localhost:3/']) {
      expect(isLoopbackUrl(u)).toBe(true);
    }
  });

  test('non scambia per locale un host che ci somiglia', () => {
    for (const u of ['https://localhost.example.com/', 'https://example.com/', 'not a url']) {
      expect(isLoopbackUrl(u)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Il rifiuto del guscio
//
// Questo caso non arriva da WebKit: la navigazione non parte proprio, quindi
// non c'è nessun did-fail e prima non c'era NIENTE da mostrare — la pane
// restava vuota e muta. È la pagina bianca che ha aperto tutta la storia.
// ---------------------------------------------------------------------------

describe('navigazione rifiutata dal guscio (-7001)', () => {
  test('un file locale: dice che si può avere lo stesso, e come', () => {
    const t = navErrorMessage({
      url: 'file:///Users/x/Documents/contratto.pdf',
      description: 'scheme "file" is not allowed in a browser pane',
      code: -7001,
    });
    expect(t.message).toContain('file sul disco');
    expect(t.hint).toContain('serviti');
  });

  test('uno schema qualunque: dice cosa apre il pannello', () => {
    const t = navErrorMessage({
      url: 'chrome://settings',
      description: 'scheme "chrome" is not allowed in a browser pane',
      code: -7001,
    });
    expect(t.message).toContain('non si apre');
    expect(t.hint).toContain('http');
    expect(t.hint).toContain('chrome://settings');
  });

  test('non si confonde con un errore di rete vero', () => {
    const rete = navErrorMessage({ url: 'http://localhost:3210/', description: 'Could not connect to the server.', code: -1004 });
    expect(rete.message).not.toContain('pannello');
  });
});
