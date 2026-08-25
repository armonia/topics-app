import { afterEach, describe, expect, test } from 'bun:test';
import type { ChatMessage } from '../types';
import {
  __messageStoreDebug,
  __resetMessageStore,
  evictSessions,
  getAllMessages,
  getSessionMessagesFromStore,
  listSessions,
  replaceAllMessages,
  subscribeAllMessages,
  subscribeSession,
  updateMessages,
} from './messageStore';

/**
 * Lo store esiste per una ragione sola: un token che arriva in una chat deve
 * svegliare QUELLA chat e nessun altro. Prima viveva in `App`, quindi ogni token
 * ri-renderizzava sidebar, tab bar e ogni pane — decine di volte al secondo
 * durante uno streaming.
 *
 * Questi test guardano proprio quello: chi viene svegliato, e chi no.
 *
 * @covers LEAK-01
 */

afterEach(() => {
  __resetMessageStore();
});

function msg(id: string): ChatMessage {
  return { id, role: 'assistant', content: id } as ChatMessage;
}

describe('lettura', () => {
  test('una sessione senza messaggi torna sempre lo STESSO array vuoto', () => {
    // `useSyncExternalStore` va in loop infinito se lo snapshot cambia identità
    // a ogni chiamata: questo non e' un dettaglio estetico.
    const a = getSessionMessagesFromStore('mai-vista');
    const b = getSessionMessagesFromStore('mai-vista');
    expect(a).toBe(b);
    expect(a).toEqual([]);
  });

  test("l'identità di una sessione regge finché non cambia", () => {
    replaceAllMessages({ s1: [msg('a')] });
    const first = getSessionMessagesFromStore('s1');
    updateMessages((p) => ({ ...p, s2: [msg('b')] }));
    // s2 e' cambiata, s1 no: chi guarda s1 non deve vedere niente di nuovo.
    expect(getSessionMessagesFromStore('s1')).toBe(first);
  });
});

describe('notifiche mirate', () => {
  test('cambia una sessione: si sveglia solo chi la guarda', () => {
    replaceAllMessages({ s1: [msg('a')], s2: [msg('b')] });
    let n1 = 0;
    let n2 = 0;
    subscribeSession('s1', () => { n1++; });
    subscribeSession('s2', () => { n2++; });

    updateMessages((p) => ({ ...p, s1: [...p.s1, msg('nuovo')] }));

    expect(n1).toBe(1);
    expect(n2).toBe(0); // <- il punto di tutto il modulo
  });

  test('un updater che non cambia niente non sveglia nessuno', () => {
    replaceAllMessages({ s1: [msg('a')] });
    let n = 0;
    subscribeSession('s1', () => { n++; });
    subscribeAllMessages(() => { n++; });
    updateMessages((p) => p);
    expect(n).toBe(0);
  });

  test('una sessione RIMOSSA sveglia chi la guardava', () => {
    // Cancellare una chat deve arrivare a chi la sta mostrando, o resta a
    // guardare messaggi che non esistono piu'.
    replaceAllMessages({ s1: [msg('a')], s2: [msg('b')] });
    let n = 0;
    subscribeSession('s1', () => { n++; });
    updateMessages(() => ({ s2: [msg('b')] }));
    expect(n).toBe(1);
    expect(getSessionMessagesFromStore('s1')).toEqual([]);
  });

  test('una sessione NUOVA sveglia chi la aspettava', () => {
    let n = 0;
    subscribeSession('futura', () => { n++; });
    updateMessages((p) => ({ ...p, futura: [msg('primo')] }));
    expect(n).toBe(1);
  });

  test('i globali si svegliano una volta sola per aggiornamento', () => {
    let g = 0;
    subscribeAllMessages(() => { g++; });
    updateMessages(() => ({ a: [msg('1')], b: [msg('2')], c: [msg('3')] }));
    expect(g).toBe(1);
  });
});

describe('igiene delle sottoscrizioni', () => {
  test('disiscriversi ferma le notifiche', () => {
    replaceAllMessages({ s1: [] });
    let n = 0;
    const off = subscribeSession('s1', () => { n++; });
    updateMessages((p) => ({ ...p, s1: [msg('a')] }));
    expect(n).toBe(1);
    off();
    updateMessages((p) => ({ ...p, s1: [msg('b')] }));
    expect(n).toBe(1);
  });

  test("l'ultimo che se ne va porta via il Set", () => {
    // Senza potatura la mappa crescerebbe quanto il numero di sessioni mai
    // aperte, e resterebbe piena di Set vuoti per sempre.
    const off1 = subscribeSession('s1', () => {});
    const off2 = subscribeSession('s1', () => {});
    expect(__messageStoreDebug().iscritti).toBe(2);
    off1();
    off2();
    expect(__messageStoreDebug().iscritti).toBe(0);
  });

  test('disiscriversi due volte non rompe niente', () => {
    const off = subscribeSession('s1', () => {});
    off();
    off();
    expect(__messageStoreDebug().iscritti).toBe(0);
  });
});

describe('i fatti per lo sfratto', () => {
  test('listSessions dice chi e\' guardata e quanto pesa', () => {
    replaceAllMessages({ s1: [msg('a'), msg('b')], s2: [] });
    subscribeSession('s1', () => {});

    const byKey = Object.fromEntries(listSessions().map((s) => [s.key, s]));
    expect(byKey.s1.watched).toBe(true);
    expect(byKey.s1.messages).toBe(2);
    expect(byKey.s2.watched).toBe(false);
    expect(byKey.s2.messages).toBe(0);
  });

  test('scrivere una sessione la marca come toccata ADESSO', () => {
    const prima = Date.now();
    replaceAllMessages({ s1: [msg('a')] });
    const s1 = listSessions().find((s) => s.key === 's1');
    expect(s1!.lastTouchedAt).toBeGreaterThanOrEqual(prima);
  });

  test("l'ultimo che smette di guardare fa ripartire il conto della grazia", () => {
    // Una chat guardata per un'ora senza che arrivi un messaggio sarebbe
    // altrimenti vecchia di un'ora nell'istante in cui la chiudi, e sfrattabile
    // al primo giro dello spazzino.
    replaceAllMessages({ s1: [msg('a')] });
    const off = subscribeSession('s1', () => {});
    const scritta = listSessions().find((s) => s.key === 's1')!.lastTouchedAt;

    const primaDiLasciarla = Date.now();
    off();

    const lasciata = listSessions().find((s) => s.key === 's1')!.lastTouchedAt;
    expect(lasciata).toBeGreaterThanOrEqual(primaDiLasciarla);
    expect(lasciata).toBeGreaterThanOrEqual(scritta);
  });

  test('con due che guardano, il primo che se ne va non fa ripartire niente', () => {
    replaceAllMessages({ s1: [msg('a')] });
    const off1 = subscribeSession('s1', () => {});
    subscribeSession('s1', () => {});
    const prima = listSessions().find((s) => s.key === 's1')!.lastTouchedAt;
    off1();
    expect(listSessions().find((s) => s.key === 's1')!.lastTouchedAt).toBe(prima);
  });

  test('una sessione mai toccata (idratata al boot) vale come vecchissima', () => {
    // `replaceAllMessages` passa da `updateMessages`, quindi marca. Il caso da
    // proteggere e' quello di una chiave che entra senza passare di li': deve
    // risultare sfrattabile per prima, non protetta per sempre.
    __resetMessageStore();
    const vuota = listSessions();
    expect(vuota).toEqual([]);
  });
});

describe('sfratto', () => {
  test('restituisce la memoria e sveglia chi ascoltava tutto', () => {
    replaceAllMessages({ s1: [msg('a')], s2: [msg('b')] });
    let g = 0;
    subscribeAllMessages(() => { g++; });

    expect(evictSessions(['s1'])).toEqual(['s1']);
    expect(getAllMessages()).toEqual({ s2: [msg('b')] });
    expect(g).toBe(1);
  });

  test('RIFIUTA di sfrattare una sessione guardata', () => {
    // L'invariante va difesa qui e non solo nella politica: chiamare questa
    // funzione a mano dalla console non deve poter svuotare una lista a schermo.
    replaceAllMessages({ s1: [msg('a')] });
    subscribeSession('s1', () => {});
    expect(evictSessions(['s1'])).toEqual([]);
    expect(getSessionMessagesFromStore('s1')).toHaveLength(1);
  });

  test('ignora le chiavi che non ci sono, senza toccare lo stato', () => {
    replaceAllMessages({ s1: [msg('a')] });
    const prima = getAllMessages();
    expect(evictSessions(['fantasma'])).toEqual([]);
    expect(getAllMessages()).toBe(prima); // nemmeno un giro di notifiche
  });

  test('sfrattare toglie anche il ricordo di quando era stata toccata', () => {
    replaceAllMessages({ s1: [msg('a')] });
    evictSessions(['s1']);
    expect(listSessions().map((s) => s.key)).not.toContain('s1');
    // E se rientra, riparte pulita: nessuna eta' ereditata dal giro precedente.
    const prima = Date.now();
    updateMessages((p) => ({ ...p, s1: [msg('a')] }));
    expect(listSessions().find((s) => s.key === 's1')!.lastTouchedAt).toBeGreaterThanOrEqual(prima);
  });
});

describe('la firma resta quella di useState', () => {
  test("l'updater riceve lo stato precedente e ne torna uno nuovo", () => {
    // E' cio' che ha permesso di spostare i messaggi fuori da `App` senza
    // toccare nessuno dei venticinque `setMessages` di `useChat`.
    replaceAllMessages({ s1: [msg('a')] });
    updateMessages((prev) => {
      expect(prev.s1).toHaveLength(1);
      return { ...prev, s1: [...prev.s1, msg('b')] };
    });
    expect(getAllMessages().s1).toHaveLength(2);
  });
});
