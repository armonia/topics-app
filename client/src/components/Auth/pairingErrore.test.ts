/**
 * The pairing screen must not blame the network for an answer it received.
 *
 * THE BUG THIS FIXES, in full. Opening Topics from the phone showed the
 * `pair.unreachable` line ("I can't reach Topics. Is the computer switched
 * on?") while the computer was on and answering.
 *
 * The screen treated every failed attempt the same way, so a `429`
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
// The catalogue KEYS, not the dictionary: `i18n.ts` deliberately does not
// export `IT`, because reading a value by hand is how a string stops following
// the chosen language. All that is needed here is that the key EXISTS.
import { chiaviDelCatalogo } from '../../lib/i18n';
import EN from '../../lib/i18n-en';

describe('pairing · la frase dice ciò che è successo davvero', () => {
  test('un rifiuto ARRIVATO non diventa «non riesco a contattare»', () => {
    // THE case. `too_many_requests` is an answer from the server: rendering it
    // as unreachability sends someone to check a computer that is replying.
    const motivo = motivoDaRisposta({ error: 'too_many_requests' });
    expect(chiaveFrase(motivo)).toBe('auth.err.too_many_requests');
    expect(chiaveFrase(motivo)).not.toBe('pair.unreachable');
  });

  test('la fetch che non torna resta «non riesco a contattare»', () => {
    // The other direction, and it is needed: a version that NEVER said
    // unreachable would pass the test above and be just as broken.
    expect(chiaveFrase('unreachable')).toBe('pair.unreachable');
  });

  test('un corpo senza codice, o illeggibile, cade sulla frase generica', () => {
    // A 500 carrying an HTML page, or a server newer than the client: a
    // generic sentence beats a silent panel.
    for (const corpo of [null, undefined, {}, { error: 'un_codice_di_domani' }]) {
      expect(chiaveFrase(motivoDaRisposta(corpo))).toBe('auth.err.generic');
    }
  });

  test('ogni codice che il server può mandare ha una frase, in ENTRAMBE le lingue', () => {
    // The real gate: the screen hands `chiaveFrase` to `t()` without looking
    // inside it, so a key with no translation would be the key itself printed
    // on the phone's screen.
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
    // The common case is transient (a server finishing its restart): waiting
    // half a minute there would be a screen stopped for nothing.
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
