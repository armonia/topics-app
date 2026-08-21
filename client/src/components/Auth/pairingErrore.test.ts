/**
 * The pairing screen must not blame the network for an answer it received.
 *
 * THE BUG THIS FIXES, in full. Opening Topics from the phone showed «Non riesco
 * a contattare Topics. Il computer è acceso?» while the computer was on and
 * answering. The screen treated every failed attempt the same way, so a `429`
 * from the per-address pairing cap, a reply that had ARRIVED, was rendered as
 * unreachability. Measured through the live relay on 2026-08-21: first POST
 * 200, then 429 on every retry, because behind the relay a whole household
 * shares one public address.
 *
 * Two separate defects, so two separate groups below: the phrase (say what the
 * server said) and the way out (a screen that only retried when a human
 * reloaded the page was a dead end).
 *
 * No renderer and no DOM: jsdom/happy-dom are not dependencies of this project
 * (same choice as `lib/haptics.test.ts` and `Settings/IdentitySection.test.tsx`).
 * The judgement lives in pure functions, so the test calls them.
 */
import { describe, test, expect } from 'bun:test';

import {
  attesaRiprova, chiaveFrase, motivoDaRisposta,
  ATTESA_BASE_MS, ATTESA_MAX_MS,
} from './pairingErrore';
import { CODICI_AUTH } from '../../lib/authErrors';
// Le chiavi del catalogo, non il dizionario: `i18n.ts` non esporta `IT` apposta
// — leggere un valore a mano è la strada per cui una stringa smette di seguire
// la lingua scelta. Qui serve solo sapere che la chiave ESISTE.
import { chiaviDelCatalogo } from '../../lib/i18n';
import EN from '../../lib/i18n-en';

describe('pairing · la frase dice ciò che è successo davvero', () => {
  test('un rifiuto ARRIVATO non diventa «non riesco a contattare»', () => {
    // IL caso. `too_many_requests` è una risposta del server: dirlo come
    // irraggiungibilità manda a controllare un computer che sta rispondendo.
    const motivo = motivoDaRisposta({ error: 'too_many_requests' });
    expect(chiaveFrase(motivo)).toBe('auth.err.too_many_requests');
    expect(chiaveFrase(motivo)).not.toBe('pair.unreachable');
  });

  test('la fetch che non torna resta «non riesco a contattare»', () => {
    // L'altra direzione, e serve: una versione che non dicesse MAI
    // irraggiungibilità passerebbe il test qui sopra e sarebbe rotta uguale.
    expect(chiaveFrase('unreachable')).toBe('pair.unreachable');
  });

  test('un corpo senza codice, o illeggibile, cade sulla frase generica', () => {
    // Un 500 con una pagina HTML dentro, o un server più nuovo del client:
    // meglio una frase generica che un pannello muto.
    for (const corpo of [null, undefined, {}, { error: 'un_codice_di_domani' }]) {
      expect(chiaveFrase(motivoDaRisposta(corpo))).toBe('auth.err.generic');
    }
  });

  test('ogni codice che il server può mandare ha una frase, in ENTRAMBE le lingue', () => {
    // Il cancello vero: la schermata passa `chiaveFrase` a `t()` senza
    // guardarci dentro, quindi una chiave senza traduzione diventerebbe la
    // chiave stessa stampata a schermo del telefono.
    const italiane = new Set(chiaviDelCatalogo());
    const inglesi = EN as Record<string, string>;
    const daTradurre = [
      ...CODICI_AUTH.map((c) => chiaveFrase(motivoDaRisposta({ error: c }))),
      chiaveFrase('unreachable'),
      'pair.retrying',
      'pair.retry',
    ];
    for (const chiave of daTradurre) {
      expect(italiane.has(chiave)).toBe(true);
      expect(typeof inglesi[chiave]).toBe('string');
    }
  });
});

describe('pairing · la schermata riprova da sola', () => {
  test('il primo tentativo riprova presto, non fra mezzo minuto', () => {
    // Il caso comune è transitorio (il server che finisce di riavviarsi): far
    // aspettare mezzo minuto lì sarebbe una schermata ferma per niente.
    expect(attesaRiprova(1)).toBe(ATTESA_BASE_MS);
  });

  test('l’attesa cresce, così un computer spento non scalda il telefono', () => {
    expect(attesaRiprova(2)).toBeGreaterThan(attesaRiprova(1));
    expect(attesaRiprova(3)).toBeGreaterThan(attesaRiprova(2));
  });

  test('ma non cresce all’infinito: chi riaccende il computer non aspetta minuti', () => {
    for (const n of [10, 50, 1000]) {
      expect(attesaRiprova(n)).toBeLessThanOrEqual(ATTESA_MAX_MS);
    }
  });

  test('nessuna attesa è zero: una riprova immediata è un ciclo di richieste', () => {
    for (let n = 1; n <= 20; n++) expect(attesaRiprova(n)).toBeGreaterThan(0);
  });
});
