/**
 * @covers RUNTIME-10
 */
import { describe, expect, test } from 'bun:test';
import { decideCacheWrite } from './messageCacheWrite';

/**
 * La cache dei messaggi non costava la quota, costava il GIORNALE: 1,52 GB di
 * WAL su 3,2 GB di store WebKit misurati il 2026-08-11, riassorbiti in 5,1 MB
 * da un checkpoint su copia. Ogni `setItem` riappende le pagine toccate, quindi
 * il prezzo si paga a scrittura, non a byte tenuti.
 *
 * Questi test tengono ferme le due scritture che non devono piu' partire.
 */

/** Un messaggio finto con un corpo della dimensione voluta. */
const msg = (id: string, bodyLen: number) => ({ id, content: 'x'.repeat(bodyLen) });

/** Il default del chiamante, cosi' i numeri qui parlano la stessa lingua. */
const CAP = 256 * 1024;
const MAX_MESSAGES = 50;

describe("decideCacheWrite: il tetto in byte e' ASSOLUTO", () => {
  test("un solo messaggio piu' grande del tetto non si scrive: si toglie la voce", () => {
    // Il caso reale: il ciclo di dimezzamento scendeva fino a `take = 1` e poi
    // scriveva comunque, 821 KB contro un tetto di 256 KB.
    const d = decideCacheWrite({
      settled: [msg('gigante', 821 * 1024)],
      previous: '[{"id":"vecchio"}]',
      maxMessages: MAX_MESSAGES,
      maxBytes: CAP,
    });
    expect(d).toEqual({ action: 'drop', reason: 'oversize' });
  });

  test('senza niente in cache, un messaggio fuori tetto non tocca il disco', () => {
    const d = decideCacheWrite({
      settled: [msg('gigante', 821 * 1024)],
      previous: null,
      maxMessages: MAX_MESSAGES,
      maxBytes: CAP,
    });
    // Nessun `removeItem` su una chiave che non esiste: non c'e' niente da togliere.
    expect(d).toEqual({ action: 'skip', reason: 'absent' });
  });

  test('molti messaggi giganti: nemmeno la coda da uno ci sta, quindi si droppa', () => {
    const settled = Array.from({ length: 50 }, (_, i) => msg(`m${i}`, 400 * 1024));
    const d = decideCacheWrite({
      settled,
      previous: 'qualcosa',
      maxMessages: MAX_MESSAGES,
      maxBytes: CAP,
    });
    expect(d).toEqual({ action: 'drop', reason: 'oversize' });
  });

  test("la coda si accorcia finche' entra, e cio' che si scrive sta nel tetto", () => {
    // 50 messaggi da 30 KB sforano; il dimezzamento si ferma appena entra.
    const settled = Array.from({ length: 50 }, (_, i) => msg(`m${i}`, 30 * 1024));
    const d = decideCacheWrite({
      settled,
      previous: null,
      maxMessages: MAX_MESSAGES,
      maxBytes: CAP,
    });
    if (d.action !== 'write') throw new Error(`atteso write, arrivato ${d.action}`);
    expect(d.payload.length).toBeLessThanOrEqual(CAP);
    expect(d.kept).toBeGreaterThan(0);
    expect(d.kept).toBeLessThan(50);
    // Taglia dalla CODA: l'ultimo messaggio c'e' sempre.
    expect(d.payload).toContain('"m49"');
  });

  test('quello che entra si scrive intero, senza potature inventate', () => {
    const settled = [msg('a', 10), msg('b', 10)];
    const d = decideCacheWrite({
      settled,
      previous: null,
      maxMessages: MAX_MESSAGES,
      maxBytes: CAP,
    });
    expect(d).toEqual({ action: 'write', payload: JSON.stringify(settled), kept: 2 });
  });

  test("nessun messaggio: si scrive la lista vuota, non l'array intero", () => {
    // `slice(-0)` e' `slice(0)`: la trappola che il modulo evita per costruzione.
    const d = decideCacheWrite({
      settled: [],
      previous: null,
      maxMessages: MAX_MESSAGES,
      maxBytes: CAP,
    });
    expect(d).toEqual({ action: 'write', payload: '[]', kept: 0 });
  });

  test('il tetto conta la voce SERIALIZZATA, non i messaggi', () => {
    // 5 messaggi da 30 caratteri starebbero in 150, ma con virgolette e graffe
    // la voce pesa di piu': il confronto va fatto sul payload.
    const settled = Array.from({ length: 5 }, (_, i) => msg(`m${i}`, 30));
    const d = decideCacheWrite({
      settled,
      previous: null,
      maxMessages: MAX_MESSAGES,
      maxBytes: 120,
    });
    if (d.action !== 'write') throw new Error(`atteso write, arrivato ${d.action}`);
    expect(d.payload.length).toBeLessThanOrEqual(120);
  });
});

describe('decideCacheWrite: la riscrittura identica non parte', () => {
  test("stesso contenuto gia' in cache: nessuna scrittura", () => {
    const settled = [msg('a', 100), msg('b', 100)];
    const d = decideCacheWrite({
      settled,
      previous: JSON.stringify(settled),
      maxMessages: MAX_MESSAGES,
      maxBytes: CAP,
    });
    expect(d).toEqual({ action: 'skip', reason: 'identical' });
  });

  test("un messaggio in piu': la scrittura parte", () => {
    const before = [msg('a', 100)];
    const d = decideCacheWrite({
      settled: [...before, msg('b', 100)],
      previous: JSON.stringify(before),
      maxMessages: MAX_MESSAGES,
      maxBytes: CAP,
    });
    expect(d.action).toBe('write');
  });

  test("cambia un byte nell'ultimo messaggio: si riscrive", () => {
    const before = [msg('a', 100), msg('b', 100)];
    const d = decideCacheWrite({
      settled: [msg('a', 100), msg('b', 101)],
      previous: JSON.stringify(before),
      maxMessages: MAX_MESSAGES,
      maxBytes: CAP,
    });
    expect(d.action).toBe('write');
  });

  test('identico DOPO la potatura: conta il payload, non la lista di partenza', () => {
    // Due giri con lo stesso stato ma tetto stretto: il secondo salta anche se
    // la coda di partenza e' lunga, perche' cio' che si scriverebbe e' bit per
    // bit cio' che c'e' gia'.
    const settled = Array.from({ length: 50 }, (_, i) => msg(`m${i}`, 30 * 1024));
    const primo = decideCacheWrite({
      settled,
      previous: null,
      maxMessages: MAX_MESSAGES,
      maxBytes: CAP,
    });
    if (primo.action !== 'write') throw new Error(`atteso write, arrivato ${primo.action}`);
    const secondo = decideCacheWrite({
      settled,
      previous: primo.payload,
      maxMessages: MAX_MESSAGES,
      maxBytes: CAP,
    });
    expect(secondo).toEqual({ action: 'skip', reason: 'identical' });
  });
});

/**
 * IL BANCO. Non prova che il WAL cala: quello succede a valle, dentro WebKit.
 * Prova la cosa da cui il WAL dipende, cioe' quanti byte lasciano il client, e
 * lo fa mettendo a confronto il vecchio percorso e il nuovo sugli stessi dati.
 */
type FakeMessage = { id: string; content: string };

/**
 * Il percorso PRE-FIX, copiato riga per riga da `cacheMessages` com'era: dimezza
 * la coda, esce a `take = 1` senza ricontrollare, e scrive sempre. Vive qui e
 * solo qui, per avere un numero da confrontare invece di una stima.
 */
function oldWrite(settled: readonly FakeMessage[]): string {
  let take = Math.min(settled.length, MAX_MESSAGES);
  let payload = JSON.stringify(settled.slice(-take));
  while (take > 1 && payload.length > CAP) {
    take = Math.floor(take / 2);
    payload = JSON.stringify(settled.slice(-take));
  }
  return payload;
}

/** Uno storage finto che conta cosa gli arriva. */
function banco() {
  const KEY = 'messages-cache-topic:banco';
  const store = new Map<string, string>();
  let writes = 0;
  let bytes = 0;
  let removes = 0;
  return {
    get writes() { return writes; },
    get bytes() { return bytes; },
    get removes() { return removes; },
    /** Le sole mosse su storage che `cacheMessages` fa oggi. */
    nuovo(settled: readonly FakeMessage[]) {
      const d = decideCacheWrite({
        settled,
        previous: store.get(KEY) ?? null,
        maxMessages: MAX_MESSAGES,
        maxBytes: CAP,
      });
      if (d.action === 'skip') return;
      if (d.action === 'drop') { store.delete(KEY); removes++; return; }
      store.set(KEY, d.payload);
      writes++;
      bytes += d.payload.length;
    },
    /** Quelle che faceva prima: una scrittura ogni chiamata, sempre. */
    vecchio(settled: readonly FakeMessage[]) {
      const payload = oldWrite(settled);
      store.set(KEY, payload);
      writes++;
      bytes += payload.length;
    },
  };
}

describe('quanto scrive il client, contato', () => {
  test('venti idratazioni della STESSA storia: 20 blob prima, 1 adesso', () => {
    // `loadHistory` richiama `cacheMessages` a ogni montaggio, riconnessione e
    // ricarico, e la storia che arriva e' quasi sempre quella gia' in cache.
    const settled = Array.from({ length: 40 }, (_, i) => msg(`m${i}`, 4 * 1024));
    const prima = banco();
    const adesso = banco();
    for (let i = 0; i < 20; i++) { prima.vecchio(settled); adesso.nuovo(settled); }

    expect(prima.writes).toBe(20);
    expect(adesso.writes).toBe(1);
    expect(adesso.bytes).toBe(Math.round(prima.bytes / 20));
  });

  test('venti turni che crescono: le scritture VERE restano tutte', () => {
    // Il freno non deve mangiarsi le scritture legittime.
    const prima = banco();
    const adesso = banco();
    const settled: FakeMessage[] = [];
    for (let i = 0; i < 20; i++) {
      settled.push(msg(`m${i}`, 4 * 1024));
      prima.vecchio(settled);
      adesso.nuovo(settled);
    }
    expect(adesso.writes).toBe(20);
    expect(adesso.bytes).toBe(prima.bytes);
  });

  test('un turno gigante ripetuto dieci volte: 8,2 MB prima, zero byte adesso', () => {
    const gigante = [msg('vecchio', 1024), msg('gigante', 821 * 1024)];
    const prima = banco();
    const adesso = banco();
    // La cache sana di prima, che i due scrivono uguale.
    prima.vecchio([msg('vecchio', 1024)]);
    adesso.nuovo([msg('vecchio', 1024)]);
    const sanaPrima = prima.bytes;
    const healthyNow = adesso.bytes;

    for (let i = 0; i < 10; i++) { prima.vecchio(gigante); adesso.nuovo(gigante); }

    // Prima: dieci blob fuori tetto, oltre 8 MB sul giornale.
    expect(prima.bytes - sanaPrima).toBeGreaterThan(8 * 1024 * 1024);
    // Adesso: nessun byte, e una sola rimozione, quella della voce vecchia.
    expect(adesso.bytes).toBe(healthyNow);
    expect(adesso.removes).toBe(1);
  });
});
