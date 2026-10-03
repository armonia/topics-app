/**
 * La coda del turno — le regole che prima non c'erano.
 *
 * Ogni caso qui sotto è un guasto vero del codice precedente, non un'ipotesi:
 * lo stop che faceva PARTIRE il messaggio in coda, le due finestre che
 * drenavano la stessa testa, il sorpasso di chi scriveva dopo uno stop, e la
 * coda vecchia che al primo caricamento del codice nuovo sarebbe evaporata.
 *
 * @covers CHAT-QUEUE-01
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import {
  __setQueueStorage, adoptLegacyQueue, claimBatch, clearQueue, decideSend, dropStoredTurns, enqueueTurn,
  getQueue, holdQueue, isHeld, legacyQueueKey, mergeBatch, parseQueue, queueKey, releaseClaim,
  liftedStop, releaseHold, removeTurn, requeueFront, updateTurn, BATCH_SEPARATOR, CLAIM_LEASE_MS,
} from './chatQueue';
import { __resetServerTurns, noteServerTurn } from './serverTurn';
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
    enqueueTurn(SK, 'primo', { fastMode: true });
    expect(store.map.has(queueKey(SK))).toBe(true);

    // Simula un'altra finestra (o un reload): cache azzerata, si rilegge da disco.
    __setQueueStorage(store);
    const [item] = getQueue(SK);
    expect(item.content).toBe('primo');
    expect(item.options?.fastMode).toBe(true);
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
  test('la coda esce una volta: la seconda finestra trova la prenotazione e si tira indietro', () => {
    enqueueTurn(SK, 'uno');
    enqueueTurn(SK, 'due');

    const preso = claimBatch(SK, 'finestra-A', 1_000);
    const rubato = claimBatch(SK, 'finestra-B', 1_100);

    expect(preso.map(i => i.content)).toEqual(['uno', 'due']);
    expect(rubato).toEqual([]);
    expect(getQueue(SK)).toHaveLength(0);
  });

  test('la prenotazione scade: se chi l\'aveva presa è morto, un\'altra finestra riprende', () => {
    enqueueTurn(SK, 'uno');
    claimBatch(SK, 'finestra-A', 1_000);
    enqueueTurn(SK, 'due');

    const ripreso = claimBatch(SK, 'finestra-B', 1_000 + CLAIM_LEASE_MS + 1);
    expect(ripreso.map(i => i.content)).toEqual(['due']);
  });

  test('rilasciata la prenotazione, la stessa finestra può riprendere subito', () => {
    enqueueTurn(SK, 'uno', { fastMode: true });
    enqueueTurn(SK, 'due'); // opzioni diverse: resta indietro, non si unisce
    claimBatch(SK, 'finestra-A', 1_000);
    releaseClaim(SK, 'finestra-A');
    expect(claimBatch(SK, 'finestra-B', 1_100).map(i => i.content)).toEqual(['due']);
  });

  test('su coda vuota non prenota niente: nessun lucchetto lasciato appeso', () => {
    expect(claimBatch(SK, 'finestra-A', 1_000)).toEqual([]);
    expect(store.map.has(`msgQueue:claim:${SK}`)).toBe(false);
  });

  test('un 409 rimette in TESTA: chi era dietro non scavalca', () => {
    enqueueTurn(SK, 'uno', { fastMode: true });
    enqueueTurn(SK, 'due'); // opzioni diverse: non entra nel batch
    const batch = claimBatch(SK, 'finestra-A', 1_000);

    requeueFront(SK, batch);

    expect(getQueue(SK).map(i => i.content)).toEqual(['uno', 'due']);
    // E non si duplica se per qualche strada ci torna due volte.
    requeueFront(SK, batch);
    expect(getQueue(SK).map(i => i.content)).toEqual(['uno', 'due']);
  });
});

// Il guasto: scrivere tre righe mentre l'agente lavora faceva partire TRE
// turni in fila, e il primo partiva senza aver mai visto gli altri due.
describe('la coda parte tutta insieme, non uno alla volta', () => {
  test('tre messaggi accodati escono in UN batch solo, nell\'ordine scritto', () => {
    enqueueTurn(SK, 'uno');
    enqueueTurn(SK, 'due');
    enqueueTurn(SK, 'tre');

    const batch = claimBatch(SK, 'w1', 1_000);

    expect(batch.map(i => i.content)).toEqual(['uno', 'due', 'tre']);
    expect(getQueue(SK)).toHaveLength(0);
    expect(mergeBatch(batch).content).toBe(['uno', 'due', 'tre'].join(BATCH_SEPARATOR));
  });

  test('il turno unito parte con le opzioni con cui era stato scritto', () => {
    enqueueTurn(SK, 'uno', { fastMode: true, model: 'opus' });
    enqueueTurn(SK, 'due', { fastMode: true, model: 'opus' });
    expect(mergeBatch(claimBatch(SK, 'w1', 1_000)).options).toEqual({ fastMode: true, model: 'opus' });
  });

  test('opzioni diverse spezzano il batch: il resto parte al turno dopo', () => {
    enqueueTurn(SK, 'normale');
    enqueueTurn(SK, 'ancora normale');
    enqueueTurn(SK, 'ma questo in fast', { fastMode: true });

    expect(claimBatch(SK, 'w1', 1_000).map(i => i.content)).toEqual(['normale', 'ancora normale']);
    releaseClaim(SK, 'w1');
    expect(claimBatch(SK, 'w1', 1_100).map(i => i.content)).toEqual(['ma questo in fast']);
  });

  test('opzioni assenti e opzioni vuote sono la stessa cosa: non spezzano niente', () => {
    enqueueTurn(SK, 'uno');
    enqueueTurn(SK, 'due', {});
    enqueueTurn(SK, 'tre', { fastMode: false });
    expect(claimBatch(SK, 'w1', 1_000)).toHaveLength(3);
  });

  test('l\'intero batch torna in coda se il turno non parte, nel suo ordine', () => {
    enqueueTurn(SK, 'uno');
    enqueueTurn(SK, 'due');
    const batch = claimBatch(SK, 'w1', 1_000);
    requeueFront(SK, batch);
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

  // Il freno lo toglieva SOLO un invio riuscito. Una sessione fermata e mai
  // più usata si teneva `msgQueue:hold:<sessionKey>` in localStorage a vita —
  // una chiave per sessione — e con essa una coda congelata che nemmeno un
  // reload sbloccava. Senza coda non c'è niente da trattenere.
  test('svuotare la coda spegne il freno: nessuna chiave orfana in localStorage', () => {
    enqueueTurn(SK, 'uno');
    holdQueue(SK);
    clearQueue(SK);
    expect(isHeld(SK)).toBe(false);
    expect([...store.map.keys()].filter(k => k.includes('hold'))).toEqual([]);
  });

  test('togliere a mano l’ULTIMA riga spegne il freno, toglierne una di mezzo no', () => {
    const a = enqueueTurn(SK, 'uno')!;
    const b = enqueueTurn(SK, 'due')!;
    holdQueue(SK);
    removeTurn(SK, a.id);
    expect(isHeld(SK)).toBe(true); // ne resta una: il freno serve ancora
    removeTurn(SK, b.id);
    expect(isHeld(SK)).toBe(false);
  });
});

describe('a Stop lifted once stays lifted, for every window of the profile', () => {
  beforeEach(() => __resetServerTurns());

  test('lifting the hold writes down the Stop it was raised for', () => {
    holdQueue(SK, { boot: 'b1', turnId: 4 });
    expect(liftedStop(SK)).toBeUndefined();
    releaseHold(SK);
    expect(isHeld(SK)).toBe(false);
    // Another window reads it from the same storage.
    __setQueueStorage(store);
    expect(liftedStop(SK)).toEqual({ boot: 'b1', turnId: 4 });
  });

  test('a send with no hold up lifts the latest Stop this window has heard, and a lift never goes back', () => {
    noteServerTurn(SK, { boot: 'b1', asOf: 7, turnId: 6, open: false, stopped: true });
    releaseHold(SK);
    expect(liftedStop(SK)).toEqual({ boot: 'b1', turnId: 6 });
    holdQueue(SK, { boot: 'b1', turnId: 2 });
    releaseHold(SK);
    expect(liftedStop(SK)).toEqual({ boot: 'b1', turnId: 6 });
  });

  // The Stop this window just pressed is written into the hold at once
  // (stopSession), before the server has said it. A late word about an OLDER
  // Stop (a snapshot, a close heard out of order) used to rewrite the hold with
  // it: the lift then covered only the older one, and when the word of the
  // newer Stop arrived it held the queue again after the person had sent.
  test('a late word about an older Stop does not replace the newer one in the hold', () => {
    enqueueTurn(SK, 'written before the Stop');
    holdQueue(SK, { boot: 'b1', turnId: 7 });
    noteServerTurn(SK, { boot: 'b1', asOf: 6, turnId: 5, open: false, stopped: true });
    expect(isHeld(SK)).toBe(true);
    releaseHold(SK);
    expect(liftedStop(SK)).toEqual({ boot: 'b1', turnId: 7 });
    // The server's word of the Stop the person already lifted holds nothing.
    noteServerTurn(SK, { boot: 'b1', asOf: 8, turnId: 7, open: false, stopped: true });
    expect(isHeld(SK)).toBe(false);
  });

  test('nothing heard, nothing held: no key is written', () => {
    releaseHold(SK);
    expect([...store.map.keys()]).toEqual([]);
  });
});

describe('la testa estratta non si perde', () => {
  // `claimBatch` toglie la testa dallo storage DUREVOLE. Se l'invio poi fallisce
  // per un motivo che `performSend` non raccoglie da sé (il 409 sì, la rete
  // pure), quella era l'unica copia: `requeueFront` è la strada del ritorno che
  // il commento di `claimBatch` prometteva e che nessuno percorreva.
  test('rimessa in TESTA, non in fondo: non si fa scavalcare da chi era dietro', () => {
    const primo = enqueueTurn(SK, 'primo')!;
    enqueueTurn(SK, 'secondo', { fastMode: true }); // opzioni diverse: resta in coda
    const [head] = claimBatch(SK, 'w1');
    expect(head.id).toBe(primo.id);
    expect(getQueue(SK).map(i => i.content)).toEqual(['secondo']);

    requeueFront(SK, [head]);
    expect(getQueue(SK).map(i => i.content)).toEqual(['primo', 'secondo']);
  });

  test('rimetterla due volte non la duplica', () => {
    enqueueTurn(SK, 'primo');
    const batch = claimBatch(SK, 'w1');
    requeueFront(SK, batch);
    requeueFront(SK, batch);
    expect(getQueue(SK).length).toBe(1);
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

describe('the turn a message waits for (CHAT-QUEUE-07)', () => {
  test('survives a reload, and every window reads the same one', () => {
    enqueueTurn(SK, 'typed during turn 7', undefined, { boot: 'b1', turnId: 7 });
    __setQueueStorage(store);
    expect(getQueue(SK)[0]?.waitsFor).toEqual({ boot: 'b1', turnId: 7 });
  });

  test('a batch refused with 409 goes back whole, in order, with its ids, waiting for the refusing turn', () => {
    enqueueTurn(SK, 'one', { fastMode: false });
    enqueueTurn(SK, 'two', { fastMode: false });
    enqueueTurn(SK, 'three', { fastMode: true });
    const batch = claimBatch(SK, 'w1');
    expect(batch.map((i) => i.content)).toEqual(['one', 'two']);
    requeueFront(SK, batch, { boot: 'b1', turnId: 9 });
    const back = getQueue(SK);
    expect(back.map((i) => i.content)).toEqual(['one', 'two', 'three']);
    expect(back.slice(0, 2).map((i) => i.id)).toEqual(batch.map((i) => i.id));
    expect(back[0]?.waitsFor).toEqual({ boot: 'b1', turnId: 9 });
    // The one not taken keeps what it had.
    expect(back[2]?.waitsFor).toBeUndefined();
  });

  test('a malformed mark is dropped, the message is kept', () => {
    store.setItem(queueKey(SK), JSON.stringify([{ id: 'x', content: 'kept', queuedAt: 't', waitsFor: { boot: 1 } }]));
    __setQueueStorage(store);
    expect(getQueue(SK)).toEqual([{ id: 'x', content: 'kept', options: undefined, queuedAt: 't' }]);
  });
});

/**
 * An item that already left once under its id (the send's key) and that the
 * server may hold (verifier, 03/10): merged with what was written after it,
 * the server's `duplicate_message` for that key took the new words with it.
 */
describe('an item the server may already hold', () => {
  test('it goes back as ONE item, under the head\'s key, with the words it left with', () => {
    enqueueTurn(SK, 'first');
    enqueueTurn(SK, 'second');
    const batch = claimBatch(SK, 'w1');
    releaseClaim(SK, 'w1');
    requeueFront(SK, batch, undefined, mergeBatch(batch));
    expect(getQueue(SK).map((i) => [i.id, i.content, i.sent])).toEqual([[batch[0]!.id, `first${BATCH_SEPARATOR}second`, true]]);
  });

  test('it travels alone: nothing written after it is merged into it, and it is merged into nothing', () => {
    enqueueTurn(SK, 'first');
    const batch = claimBatch(SK, 'w1');
    releaseClaim(SK, 'w1');
    requeueFront(SK, batch, undefined, mergeBatch(batch));
    enqueueTurn(SK, 'written later');
    enqueueTurn(SK, 'and later still');
    expect(claimBatch(SK, 'w1').map((i) => i.content)).toEqual(['first']);
    releaseClaim(SK, 'w1');
    expect(claimBatch(SK, 'w1').map((i) => i.content)).toEqual(['written later', 'and later still']);
  });

  test('a message that carries its key keeps it as its id, and is marked', () => {
    const item = enqueueTurn(SK, 'resent', { clientMessageId: 'key-1' });
    expect([item?.id, item?.sent]).toEqual(['key-1', true]);
    enqueueTurn(SK, 'resent', { clientMessageId: 'key-1' });
    expect(getQueue(SK)).toHaveLength(1);
  });

  test('editing its words makes a new message, under a new key', () => {
    enqueueTurn(SK, 'resent', { clientMessageId: 'key-1' });
    updateTurn(SK, 'key-1', 'resent, corrected');
    const [edited] = getQueue(SK);
    expect(edited!.id).not.toBe('key-1');
    expect(edited!.sent).toBeUndefined();
  });

  test('the mark survives the disk', () => {
    enqueueTurn(SK, 'resent', { clientMessageId: 'key-1' });
    expect(parseQueue(store.map.get(queueKey(SK)) ?? null)[0]!.sent).toBe(true);
  });
});

describe('a history read settles what the queue may have already sent', () => {
  test('a `sent` item whose key is on a row of the read leaves the queue; the rest stays', () => {
    enqueueTurn(SK, 'deploy it', { clientMessageId: 'k-stored' });
    enqueueTurn(SK, 'and run the tests');
    const removed = dropStoredTurns(SK, [{ role: 'user', clientMessageId: 'k-stored' }, { role: 'assistant' }]);
    expect(removed).toBe(1);
    expect(getQueue(SK).map((q) => q.content)).toEqual(['and run the tests']);
  });

  test('the same words under another key, or a row with no key, settle nothing', () => {
    enqueueTurn(SK, 'ok', { clientMessageId: 'k-mine' });
    expect(dropStoredTurns(SK, [{ role: 'user', clientMessageId: 'k-other' }, { role: 'user' }])).toBe(0);
    expect(getQueue(SK).map((q) => q.id)).toEqual(['k-mine']);
  });
});
