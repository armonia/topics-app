/**
 * Le tre perdite che questi test presidiano sono tutte della stessa forma: un
 * messaggio scritto dall'umano sparisce e nessuno se ne accorge. Non c'è modo di
 * beccarle guardando la UI — la chat mostra il messaggio, semplicemente non
 * arriva mai — quindi vanno inchiodate qui.
 *
 * @covers CHAT-01
 */
import { describe, it, expect } from 'bun:test';
import {
  EXPIRED_QUEUE_KEY,
  MAX_QUEUE_AGE_MS,
  OUTBOUND_QUEUE_KEY,
  decideQueuedMessage,
  enqueue,
  moveToExpired,
  queueItemKey,
  readQueue,
  removeItem,
  removeSession,
  writeQueue,
  type QueueStorage,
  type QueuedMessage,
} from './outboundQueue';

function memStorage(seed: Record<string, string> = {}): QueueStorage & { raw: Map<string, string> } {
  const raw = new Map<string, string>(Object.entries(seed));
  return {
    raw,
    getItem: (k) => raw.get(k) ?? null,
    setItem: (k, v) => void raw.set(k, v),
    removeItem: (k) => void raw.delete(k),
  };
}

const msg = (over: Partial<QueuedMessage> = {}): QueuedMessage => ({
  sessionKey: 'topic-1',
  content: 'ciao',
  timestamp: new Date(1_000_000).toISOString(),
  id: 'a',
  ...over,
});

describe('lettura e scrittura', () => {
  it('una coda illeggibile vale coda vuota, non un errore', () => {
    expect(readQueue(memStorage({ [OUTBOUND_QUEUE_KEY]: '{rotto' }), OUTBOUND_QUEUE_KEY)).toEqual([]);
    expect(readQueue(memStorage({ [OUTBOUND_QUEUE_KEY]: '{"non":"un array"}' }), OUTBOUND_QUEUE_KEY)).toEqual([]);
  });

  it('scarta le righe che non sono messaggi invece di propagarle', () => {
    const s = memStorage({ [OUTBOUND_QUEUE_KEY]: JSON.stringify([msg(), null, { content: 'senza sessione' }]) });
    expect(readQueue(s, OUTBOUND_QUEUE_KEY)).toHaveLength(1);
  });

  it('svuotare rimuove la chiave, non lascia un [] a fare da fantasma', () => {
    const s = memStorage();
    writeQueue(s, OUTBOUND_QUEUE_KEY, [msg()]);
    writeQueue(s, OUTBOUND_QUEUE_KEY, []);
    expect(s.raw.has(OUTBOUND_QUEUE_KEY)).toBe(false);
  });

  it('uno storage che rifiuta di scrivere non fa esplodere il chiamante', () => {
    const hostile: QueueStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceeded'); },
      removeItem: () => { throw new Error('nope'); },
    };
    expect(() => enqueue(hostile, OUTBOUND_QUEUE_KEY, msg())).not.toThrow();
  });
});

describe('manipolazione per item', () => {
  it('accoda in fondo e non duplica lo stesso id', () => {
    const s = memStorage();
    enqueue(s, OUTBOUND_QUEUE_KEY, msg({ id: 'a' }));
    enqueue(s, OUTBOUND_QUEUE_KEY, msg({ id: 'b', content: 'due' }));
    enqueue(s, OUTBOUND_QUEUE_KEY, msg({ id: 'a', content: 'ridondante' }));
    expect(readQueue(s, OUTBOUND_QUEUE_KEY).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('toglie UN item e lascia gli altri dove sono', () => {
    const s = memStorage();
    const a = msg({ id: 'a' });
    const b = msg({ id: 'b', content: 'due' });
    enqueue(s, OUTBOUND_QUEUE_KEY, a);
    enqueue(s, OUTBOUND_QUEUE_KEY, b);
    expect(removeItem(s, OUTBOUND_QUEUE_KEY, a).map((m) => m.id)).toEqual(['b']);
  });

  it('senza id l identità è sessione+istante+testo, quindi il removeItem centra lo stesso', () => {
    const s = memStorage();
    const legacy: QueuedMessage = { sessionKey: 't', content: 'x', timestamp: 'ieri' };
    enqueue(s, OUTBOUND_QUEUE_KEY, legacy);
    enqueue(s, OUTBOUND_QUEUE_KEY, { sessionKey: 't', content: 'y', timestamp: 'ieri' });
    expect(queueItemKey(legacy)).toBe('t ieri x');
    expect(removeItem(s, OUTBOUND_QUEUE_KEY, { ...legacy }).map((m) => m.content)).toEqual(['y']);
  });

  it('togliere per sessione non tocca le altre sessioni', () => {
    const s = memStorage();
    enqueue(s, OUTBOUND_QUEUE_KEY, msg({ id: 'a', sessionKey: 'uno' }));
    enqueue(s, OUTBOUND_QUEUE_KEY, msg({ id: 'b', sessionKey: 'due' }));
    expect(removeSession(s, OUTBOUND_QUEUE_KEY, 'uno').map((m) => m.id)).toEqual(['b']);
  });
});

describe('scaduti', () => {
  it('cambiano coda invece di evaporare, e la coda nuova è durevole', () => {
    // Perdita #3: prima finivano in uno stato React e sparivano al reload,
    // insieme al banner che li offriva in retry.
    const s = memStorage();
    const vecchio = msg({ id: 'vecchio' });
    enqueue(s, OUTBOUND_QUEUE_KEY, vecchio);
    moveToExpired(s, vecchio);

    expect(readQueue(s, OUTBOUND_QUEUE_KEY)).toEqual([]);
    expect(readQueue(s, EXPIRED_QUEUE_KEY).map((m) => m.id)).toEqual(['vecchio']);
    // Reload della pagina = storage nuovo con le stesse chiavi: deve ritrovarli.
    expect(readQueue(memStorage(Object.fromEntries(s.raw)), EXPIRED_QUEUE_KEY)).toHaveLength(1);
  });
});

describe('decisione sul singolo item', () => {
  const NOW = 5_000_000;
  const fresco = () => msg({ timestamp: new Date(NOW - 1_000).toISOString() });
  const ctx = (over: Partial<Parameters<typeof decideQueuedMessage>[1]> = {}) => ({
    now: NOW,
    locked: false,
    sessionMessages: [] as { role: string; content?: string; queued?: boolean }[],
    ...over,
  });

  it('sessione libera e messaggio fresco ⇒ si spedisce', () => {
    expect(decideQueuedMessage(fresco(), ctx())).toEqual({ action: 'send' });
  });

  it('sessione OCCUPATA ⇒ si rinvia, non si scarta', () => {
    // Perdita #2, il caso più probabile: scrivi mentre l'agente risponde.
    expect(decideQueuedMessage(fresco(), ctx({ locked: true }))).toEqual({ action: 'defer', reason: 'locked' });
  });

  it('oltre i 5 minuti ⇒ scade, anche a sessione libera', () => {
    const vecchio = msg({ timestamp: new Date(NOW - MAX_QUEUE_AGE_MS - 1).toISOString() });
    expect(decideQueuedMessage(vecchio, ctx())).toEqual({ action: 'expire' });
  });

  it('un timestamp illeggibile non fa scadere nulla per sbaglio', () => {
    expect(decideQueuedMessage(msg({ timestamp: 'boh' }), ctx())).toEqual({ action: 'send' });
  });

  it('già consegnato (c è la risposta) ⇒ si toglie, non si rispedisce', () => {
    const v = decideQueuedMessage(
      fresco(),
      ctx({ sessionMessages: [{ role: 'user', content: 'ciao' }, { role: 'assistant', content: 'eccomi' }] }),
    );
    expect(v).toEqual({ action: 'drop', reason: 'delivered' });
  });

  it('in volo (risposta ancora vuota) ⇒ si toglie', () => {
    const v = decideQueuedMessage(
      fresco(),
      ctx({ sessionMessages: [{ role: 'user', content: 'ciao' }, { role: 'assistant', content: '' }] }),
    );
    expect(v).toEqual({ action: 'drop', reason: 'in-flight' });
  });

  it('già consegnato E sessione occupata ⇒ si toglie lo stesso (il dedup precede il lock)', () => {
    // Se qui rinviassimo, un messaggio che il server ha GIÀ resterebbe in coda
    // per sempre, riproposto a ogni drain.
    const v = decideQueuedMessage(
      fresco(),
      ctx({ locked: true, sessionMessages: [{ role: 'user', content: 'ciao' }, { role: 'assistant', content: 'ok' }] }),
    );
    expect(v).toEqual({ action: 'drop', reason: 'delivered' });
  });

  it('il messaggio ancora marcato "queued" NON conta come consegnato', () => {
    // È la copia ottimistica in chat: se la contassimo, ogni item sarebbe
    // "già consegnato" e la coda si svuoterebbe senza spedire niente.
    const v = decideQueuedMessage(
      fresco(),
      ctx({ sessionMessages: [{ role: 'user', content: 'ciao', queued: true }] }),
    );
    expect(v).toEqual({ action: 'send' });
  });
});
