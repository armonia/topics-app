import { describe, expect, test } from 'bun:test';
import type { TerminalSessionInfo } from '../types';
import { decideRosterTrust, shouldDeclareExpired } from './rosterTrust';

/**
 * La regola esiste per un bug preciso: "Sessione scaduta" su un terminale VIVO.
 * Questi test guardano la sola cosa che conta — quando un roster vuoto ha il
 * diritto di far dichiarare morta una pane, e quando no.
 *
 * @covers TERM-01
 */

function s(id: string): TerminalSessionInfo {
  return { id, name: id, createdAt: '', cwd: '/tmp', type: 'shell' } as TerminalSessionInfo;
}

const VUOTO: TerminalSessionInfo[] = [];

describe('un roster non vuoto si crede sempre', () => {
  test('nessun server inventa sessioni: se ne elenca una, è reale', () => {
    const d = decideRosterTrust({ incoming: [s('a')], previous: VUOTO, wasAuthoritative: false });
    expect(d).toEqual({ authoritative: true, accept: true, cache: true });
  });

  test('vale anche senza il flag dal server (è il caso della fetch REST)', () => {
    const d = decideRosterTrust({ incoming: [s('a')], previous: [s('b')], wasAuthoritative: false });
    expect(d.authoritative).toBe(true);
  });
});

describe('un roster VUOTO', () => {
  test('col flag reconciled si crede: è "hai chiuso tutti i terminali"', () => {
    // Senza questo ramo una pane davvero morta resterebbe a ritentare in eterno.
    const d = decideRosterTrust({ incoming: VUOTO, reconciled: true, previous: [s('a')], wasAuthoritative: false });
    expect(d).toEqual({ authoritative: true, accept: true, cache: true });
  });

  test('SENZA flag e con sessioni prima: NON si crede e NON si accetta', () => {
    // <- il ramo che il bug attraversava. Il `200 []` prematuro del server
    //    finiva nello stato e nella cache, e da lì la pane viva moriva.
    const d = decideRosterTrust({ incoming: VUOTO, previous: [s('a')], wasAuthoritative: false });
    expect(d).toEqual({ authoritative: false, accept: false, cache: false });
  });

  test('senza flag ma non avevamo niente da perdere: si crede', () => {
    // Senza questo ramo una macchina senza terminali non promuoverebbe MAI il
    // roster, e il gate resterebbe chiuso per sempre sul caso più banale.
    const d = decideRosterTrust({ incoming: VUOTO, previous: VUOTO, wasAuthoritative: false });
    expect(d.authoritative).toBe(true);
  });

  test('reconciled:false è trattato come "non lo so", non come una conferma', () => {
    const d = decideRosterTrust({ incoming: VUOTO, reconciled: false, previous: [s('a')], wasAuthoritative: false });
    expect(d.accept).toBe(false);
  });
});

describe("una promozione non si perde", () => {
  test('un vuoto sospetto non declassa un roster già confermato', () => {
    // Il gate della pane guarda questo booleano: se un `200 []` prematuro potesse
    // riportarlo a false, il bug tornerebbe dalla finestra.
    const d = decideRosterTrust({ incoming: VUOTO, previous: [s('a')], wasAuthoritative: true });
    expect(d.authoritative).toBe(true);
    expect(d.accept).toBe(false); // ...ma resta il rifiuto di distruggere lo stato
  });
});

/**
 * L'altra metà: la pane deve MOLLARE quando la sessione è davvero morta. Prima di
 * oggi nessun test copriva questa decisione — né il bug né una sua rottura
 * sarebbero stati visti (`grep 'terminal-stale-overlay' tests/` → zero).
 */
describe('quando la pane dichiara scaduta', () => {
  const GRAZIA = 5;

  test('roster CONFERMATO, sessione assente, oltre la grazia → SCADUTA', () => {
    // <- l'invariante da non perdere. Un fix che non arriva qui nasconde una pane
    //    morta per sempre invece di dirlo.
    expect(shouldDeclareExpired({
      sessionListed: false, rosterAuthoritative: true, retryCount: 6, graceRetries: GRAZIA,
    })).toBe(true);
  });

  test('sessione NEL roster → mai scaduta, per quanti ritenti si accumulino', () => {
    // È la proprietà lossless: una ricarica del server non può abbandonare un
    // terminale la cui sessione è viva.
    expect(shouldDeclareExpired({
      sessionListed: true, rosterAuthoritative: true, retryCount: 999, graceRetries: GRAZIA,
    })).toBe(false);
  });

  test('roster NON confermato → mai scaduta: la sua assenza non prova niente', () => {
    // <- il gate del 2026-07-30. Senza, questo caso tornava true su una sessione
    //    che il reconcile stava per riattaccare viva.
    expect(shouldDeclareExpired({
      sessionListed: false, rosterAuthoritative: false, retryCount: 999, graceRetries: GRAZIA,
    })).toBe(false);
  });

  test('dentro la grazia non si dichiara, nemmeno a roster confermato', () => {
    for (let n = 1; n <= GRAZIA; n++) {
      expect(shouldDeclareExpired({
        sessionListed: false, rosterAuthoritative: true, retryCount: n, graceRetries: GRAZIA,
      })).toBe(false);
    }
  });

  test('il confine è esattamente graceRetries, non uno prima', () => {
    expect(shouldDeclareExpired({
      sessionListed: false, rosterAuthoritative: true, retryCount: GRAZIA, graceRetries: GRAZIA,
    })).toBe(false);
    expect(shouldDeclareExpired({
      sessionListed: false, rosterAuthoritative: true, retryCount: GRAZIA + 1, graceRetries: GRAZIA,
    })).toBe(true);
  });
});
