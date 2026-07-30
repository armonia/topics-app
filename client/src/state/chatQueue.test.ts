/**
 * La coda del turno — le regole che prima non c'erano.
 *
 * Ogni caso qui sotto è un guasto vero del codice precedente, non un'ipotesi:
 * lo stop che faceva PARTIRE il messaggio in coda, le due finestre che
 * drenavano la stessa testa, il sorpasso di chi scriveva dopo uno stop, e la
 * coda vecchia che al primo caricamento del codice nuovo sarebbe evaporata.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import {
  __setQueueStorage, adoptLegacyQueue, claimHead, clearQueue, decideSend, enqueueTurn,
  getQueue, holdQueue, isHeld, legacyQueueKey, parseQueue, queueKey, releaseClaim,
  releaseHold, removeTurn, requeueFront, updateTurn, CLAIM_LEASE_MS,
} from './chatQueue';
import type { QueueStorage } from '../hooks/outboundQueue';

/** Uno storage finto e ISPEZIONABILE: due «finestre» ci scrivono sopra. */
function fakeStorage(): QueueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

let store: ReturnType<typeof fakeStorage>;
const SK = 'topic:abc';

beforeEach(() => {
  store = fakeStorage();
  __setQueueStorage(store);
});

describe('accodare e rileggere', () => {
  test('un messaggio accodato è durevole e conserva le sue opzioni', () => {
    enqueueTurn(SK, 'primo', { planMode: true });
    expect(store.map.has(queueKey(SK))).toBe(true);

    // Simula un'altra finestra (o un reload): cache azzerata, si rilegge da disco.
    __setQueueStorage(store);
    const [item] = getQueue(SK);
    expect(item.content).toBe('primo');
    expect(item.options?.planMode).toBe(true);
  });

  test('il vuoto non entra in coda', () => {
    expect(enqueueTurn(SK, '   ')).toBeNull();
    expect(getQueue(SK)).toHaveLength(0);
  });

  test('svuotare la coda toglie anche la chiave: niente `[]` a marcire su disco', () => {
    enqueueTurn(SK, 'uno');
    clearQueue(SK);
    expect(store.map.has(queueKey(SK))).toBe(false);
  });

  test('correggere e togliere agiscono per id, non per posizione', () => {
    const a = enqueueTurn(SK, 'uno')!;
    const b = enqueueTurn(SK, 'due')!;
    removeTurn(SK, a.id);
    updateTurn(SK, b.id, 'due, corretto');
    expect(getQueue(SK).map(i => i.content)).toEqual(['due, corretto']);
  });
});

describe('formati vecchi', () => {
  test('una coda `string[]` non evapora al primo caricamento del codice nuovo', () => {
    const parsed = parseQueue(JSON.stringify(['ciao', 'come va']));
    expect(parsed.map(p => p.content)).toEqual(['ciao', 'come va']);
    expect(parsed[0].id).toBeTruthy();
  });

  test('la coda per-topic viene adottata dalla sessione e la vecchia chiave sparisce', () => {
    store.map.set(legacyQueueKey('t-1'), JSON.stringify([{ content: 'scritto ieri', options: { fastMode: true } }]));
    enqueueTurn(SK, 'scritto adesso');

    adoptLegacyQueue(SK, 't-1');

    expect(getQueue(SK).map(i => i.content)).toEqual(['scritto adesso', 'scritto ieri']);
    expect(getQueue(SK)[1].options?.fastMode).toBe(true);
    expect(store.map.has(legacyQueueKey('t-1'))).toBe(false);
  });

  test('roba illeggibile non fa esplodere niente: coda vuota', () => {
    expect(parseQueue('{non json')).toEqual([]);
    expect(parseQueue(JSON.stringify({ nope: 1 }))).toEqual([]);
    expect(parseQueue(JSON.stringify([{ options: {} }, '', 42]))).toEqual([]);
  });
});

describe('una finestra sola drena', () => {
  test('la testa esce una volta: la seconda finestra trova la prenotazione e si tira indietro', () => {
    enqueueTurn(SK, 'uno');
    enqueueTurn(SK, 'due');

    const preso = claimHead(SK, 'finestra-A', 1_000);
    const rubato = claimHead(SK, 'finestra-B', 1_100);

    expect(preso?.content).toBe('uno');
    expect(rubato).toBeNull();
    expect(getQueue(SK).map(i => i.content)).toEqual(['due']);
  });

  test('la prenotazione scade: se chi l\'aveva presa è morto, un\'altra finestra riprende', () => {
    enqueueTurn(SK, 'uno');
    claimHead(SK, 'finestra-A', 1_000);
    enqueueTurn(SK, 'due');

    const ripreso = claimHead(SK, 'finestra-B', 1_000 + CLAIM_LEASE_MS + 1);
    expect(ripreso?.content).toBe('due');
  });

  test('rilasciata la prenotazione, la stessa finestra può riprendere subito', () => {
    enqueueTurn(SK, 'uno');
    enqueueTurn(SK, 'due');
    claimHead(SK, 'finestra-A', 1_000);
    releaseClaim(SK, 'finestra-A');
    expect(claimHead(SK, 'finestra-B', 1_100)?.content).toBe('due');
  });

  test('su coda vuota non prenota niente: nessun lucchetto lasciato appeso', () => {
    expect(claimHead(SK, 'finestra-A', 1_000)).toBeNull();
    expect(store.map.has(`msgQueue:claim:${SK}`)).toBe(false);
  });

  test('un 409 rimette in TESTA: chi era dietro non scavalca', () => {
    enqueueTurn(SK, 'uno');
    enqueueTurn(SK, 'due');
    const head = claimHead(SK, 'finestra-A', 1_000)!;

    requeueFront(SK, head);

    expect(getQueue(SK).map(i => i.content)).toEqual(['uno', 'due']);
    // E non si duplica se per qualche strada ci torna due volte.
    requeueFront(SK, head);
    expect(getQueue(SK).map(i => i.content)).toEqual(['uno', 'due']);
  });
});

describe('lo stop tiene', () => {
  test('il freno è durevole: lo vedono anche le altre finestre', () => {
    holdQueue(SK);
    expect(isHeld(SK)).toBe(true);
    __setQueueStorage(store); // altra finestra, stessa origine
    expect(isHeld(SK)).toBe(true);
    releaseHold(SK);
    expect(isHeld(SK)).toBe(false);
  });
});

describe('decideSend', () => {
  test('sessione occupata → in coda', () => {
    expect(decideSend({ busy: true, queued: 0 })).toBe('queue');
    expect(decideSend({ busy: true, queued: 3 })).toBe('queue');
  });

  test('sessione libera e coda vuota → si spedisce', () => {
    expect(decideSend({ busy: false, queued: 0 })).toBe('send');
  });

  test('sessione libera ma coda ferma → in fondo, e riparte la testa', () => {
    // È il dopo-stop: chi scrive adesso NON deve scavalcare quello che aveva
    // scritto prima e che è rimasto lì a aspettare.
    expect(decideSend({ busy: false, queued: 2 })).toBe('queue-then-drain');
  });
});
